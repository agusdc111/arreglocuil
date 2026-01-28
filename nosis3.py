# -*- coding: utf-8 -*-
"""
nosis3.py - Búsqueda de identidad usando AFIP Web Service A13 (Padrón)
Requiere certificado AFIP (produccion.crt y privada.key en este mismo directorio)
"""

import os
import datetime
import base64
import warnings
from zeep import Client
from zeep.transports import Transport
from requests import Session
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.serialization import pkcs7
import xml.etree.ElementTree as ET
import unicodedata

# --- CONFIGURACIÓN ---
CUIT_REPRESENTANTE = 20471562735  # CUIT del dueño del certificado
DIR_ACTUAL = os.path.dirname(os.path.abspath(__file__))
NOMBRE_CERT = os.path.join(DIR_ACTUAL, "produccion.crt")
NOMBRE_KEY = os.path.join(DIR_ACTUAL, "privada.key")

# URLs PROD
WSDL_WSAA = "https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl"
WSDL_A13 = "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA13?WSDL"

warnings.filterwarnings("ignore")

# Cache para token (evitar autenticar en cada llamada)
_token_cache = {"token": None, "sign": None, "expira": None}

def _distancia_levenshtein(s1: str, s2: str) -> int:
    """Calcula la distancia de Levenshtein entre dos strings"""
    if len(s1) < len(s2):
        return _distancia_levenshtein(s2, s1)
    if len(s2) == 0:
        return len(s1)
    
    fila_anterior = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        fila_actual = [i + 1]
        for j, c2 in enumerate(s2):
            inserciones = fila_anterior[j + 1] + 1
            eliminaciones = fila_actual[j] + 1
            sustituciones = fila_anterior[j] + (c1 != c2)
            fila_actual.append(min(inserciones, eliminaciones, sustituciones))
        fila_anterior = fila_actual
    
    return fila_anterior[-1]

def _coincide_flexible(filtro: str, nombre: str) -> bool:
    """
    Verifica si el filtro coincide con el nombre de forma flexible.
    """
    if not filtro or not nombre:
        return False
    
    filtro = filtro.lower()
    nombre = nombre.lower()
    
    if filtro in nombre:
        return True
    
    palabras_nombre = nombre.split()
    for palabra in palabras_nombre:
        if len(filtro) <= 3:
            if filtro == palabra[:len(filtro)] or filtro in palabra:
                return True
            continue
        
        if filtro in palabra or palabra in filtro:
            return True
        
        max_errores = 1 if len(filtro) <= 6 else 2
        
        if _distancia_levenshtein(filtro, palabra) <= max_errores:
            return True
        
        if len(palabra) >= len(filtro):
            inicio = palabra[:len(filtro)]
            if _distancia_levenshtein(filtro, inicio) <= max_errores:
                return True
    
    return False

def _norm(s: str) -> str:
    """Normaliza texto removiendo acentos y convirtiendo a minúsculas"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return " ".join(s.lower().split())

def obtener_ticket():
    """Obtiene ticket de acceso (token + sign) de AFIP WSAA"""
    global _token_cache
    
    # Verificar si el token en cache aún es válido
    if _token_cache["token"] and _token_cache["expira"]:
        if datetime.datetime.now() < _token_cache["expira"]:
            return _token_cache["token"], _token_cache["sign"]
    
    ahora = datetime.datetime.now() - datetime.timedelta(minutes=5)
    expira = ahora + datetime.timedelta(minutes=60)
    
    xml_req = f"""<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
<header>
<uniqueId>{int(ahora.timestamp())}</uniqueId>
<generationTime>{ahora.strftime('%Y-%m-%dT%H:%M:%S')}</generationTime>
<expirationTime>{expira.strftime('%Y-%m-%dT%H:%M:%S')}</expirationTime>
</header>
<service>ws_sr_padron_a13</service>
</loginTicketRequest>""".encode('utf-8')

    try:
        with open(NOMBRE_CERT, "rb") as f: 
            cert = x509.load_pem_x509_certificate(f.read())
        with open(NOMBRE_KEY, "rb") as f: 
            key = serialization.load_pem_private_key(f.read(), password=None)
        
        signature = pkcs7.PKCS7SignatureBuilder().set_data(xml_req).add_signer(
            cert, key, hashes.SHA256()
        ).sign(serialization.Encoding.DER, [])
        
        cms = base64.b64encode(signature).decode('utf-8')
        
        session = Session()
        session.verify = True
        client = Client(WSDL_WSAA, transport=Transport(session=session))
        rta = client.service.loginCms(in0=cms)
        root = ET.fromstring(rta)
        
        token = root.find(".//token").text
        sign = root.find(".//sign").text
        
        # Guardar en cache
        _token_cache["token"] = token
        _token_cache["sign"] = sign
        _token_cache["expira"] = expira - datetime.timedelta(minutes=5)
        
        return token, sign
    except Exception as e:
        raise Exception(f"Error de autenticación AFIP: {e}")

def armar_cuit(dni, prefijo):
    """Calcula CUIL/CUIT con dígito verificador"""
    base = f"{prefijo}{str(dni).zfill(8)}"
    mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
    suma = sum(int(base[i]) * mult[i] for i in range(10))
    dv = 11 - (suma % 11)
    if dv == 11: 
        dv = 0
    elif dv == 10: 
        dv = 9
    return int(f"{base}{dv}")

def consultar_afip_directo(cuit_target, client, token, sign):
    """Consulta directa a AFIP Web Service A13 por CUIL específico"""
    try:
        res = client.service.getPersona(
            token=token, 
            sign=sign,
            cuitRepresentada=CUIT_REPRESENTANTE,
            idPersona=cuit_target
        )
        return res.persona if (res and hasattr(res, 'persona') and res.persona) else None
    except:
        return None

def extraer_nombre_completo(persona):
    """Extrae nombre completo de objeto persona de AFIP"""
    if not persona:
        return None
    
    nombre = ""
    apellido = ""
    
    if hasattr(persona, 'nombre') and persona.nombre:
        nombre = str(persona.nombre).strip()
    if hasattr(persona, 'apellido') and persona.apellido:
        apellido = str(persona.apellido).strip()
    
    nombre_completo = f"{apellido} {nombre}".strip()
    return nombre_completo if nombre_completo else None

# --- NUEVA FUNCIÓN AGREGADA ---
def extraer_fecha_nacimiento(persona):
    """Extrae la fecha de nacimiento si está disponible y la formatea a DD/MM/YYYY"""
    if not persona:
        return "S/D"
    
    if hasattr(persona, 'fechaNacimiento') and persona.fechaNacimiento:
        fecha_str = str(persona.fechaNacimiento)
        
        # Parsear fecha que viene en formato ISO: "2006-08-03 12:00:00-03:00" o "2006-08-03"
        try:
            # Extraer solo la parte de la fecha (YYYY-MM-DD)
            if ' ' in fecha_str:
                fecha_str = fecha_str.split(' ')[0]
            
            # Parsear YYYY-MM-DD
            partes = fecha_str.split('-')
            if len(partes) == 3:
                año, mes, dia = partes
                # Retornar en formato DD/MM/YYYY
                return f"{dia}/{mes}/{año}"
        except:
            # Si falla el parseo, retornar tal cual vino
            return fecha_str
    
    return "S/D"

async def nosis3_lookup(dni_o_cuil, nombre_filtro=None):
    """
    Busca identidad usando AFIP Web Service A13.
    
    Returns:
        Tupla (cuil, nombre, fecha_nacimiento) o (mensaje_error, "ERROR", None)
    """
    # Limpiar entrada
    entrada = str(dni_o_cuil).replace("-", "").replace(" ", "").strip()
    
    if not entrada.isdigit():
        return ("Debe ingresar solo números", "ERROR", None)
    
    es_dni = len(entrada) in [7, 8, 9]
    es_cuil = len(entrada) == 11
    
    if not (es_dni or es_cuil):
        return ("Longitud inválida. Debe ser DNI (7-9) o CUIL (11 dígitos)", "ERROR", None)
    
    # Normalizar filtro de nombre si existe
    nombre_filtro_norm = None
    if nombre_filtro:
        nombre_filtro_norm = _norm(nombre_filtro.strip())
    
    try:
        # Obtener credenciales AFIP
        token, sign = obtener_ticket()
        
        # Crear cliente SOAP
        session = Session()
        session.verify = True
        client = Client(WSDL_A13, transport=Transport(session=session))
        
        # CASO 1: Es un CUIL (11 dígitos) - Búsqueda directa primero
        if es_cuil:
            persona = consultar_afip_directo(entrada, client, token, sign)
            
            if persona:
                nombre_completo = extraer_nombre_completo(persona)
                fecha_nac = extraer_fecha_nacimiento(persona) # <--- EXTRACCIÓN
                
                if not nombre_completo:
                    return ("Datos incompletos en AFIP", "ERROR", None)
                
                # Si hay filtro de nombre, verificar coincidencia
                if nombre_filtro_norm:
                    nombre_norm = _norm(nombre_completo)
                    if not _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                        mensaje += f"Resultado encontrado:\nCUIL: {entrada}\n"
                        mensaje += f"NOMBRE: {nombre_completo}\n"
                        mensaje += f"NACIMIENTO: {fecha_nac}"
                        return (mensaje, "NO_MATCH", None)
                
                return (entrada, nombre_completo, fecha_nac) # <--- RETORNO CON FECHA
            else:
                # No se encontró con CUIL directo, extraer DNI y buscar con prefijos
                print(f"[NOSIS3] No se encontró CUIL {entrada} directo, extrayendo DNI...")
                entrada = entrada[2:10]  # Quitar primeros 2 dígitos y último dígito
                # Continuar con búsqueda por prefijos (convertir a DNI)
        
        # CASO 2: Es un DNI (7-9 dígitos O extraído de CUIL) - Probar variantes
        if len(entrada) in [7, 8, 9]:
            # Orden de probabilidad: 20 (H), 27 (M), 23 (Ambos)
            prefijos = [20, 27, 23]
            
            resultados_encontrados = []
            
            for pre in prefijos:
                cuit_candidato = armar_cuit(entrada, pre)
                persona = consultar_afip_directo(cuit_candidato, client, token, sign)
                
                if persona:
                    nombre_completo = extraer_nombre_completo(persona)
                    fecha_nac = extraer_fecha_nacimiento(persona) # <--- EXTRACCIÓN
                    
                    if nombre_completo:
                        resultados_encontrados.append({
                            "cuil": str(cuit_candidato),
                            "nombre": nombre_completo,
                            "fecha": fecha_nac # <--- GUARDADO
                        })
            
            if not resultados_encontrados:
                return (f"No se encontró ninguna persona activa con DNI {entrada}", "ERROR", None)
            
            # Si hay filtro de nombre, buscar coincidencia
            if nombre_filtro_norm:
                for res in resultados_encontrados:
                    nombre_norm = _norm(res["nombre"])
                    if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        return (res["cuil"], res["nombre"], res["fecha"]) # <--- RETORNO CON FECHA
                
                # No hubo coincidencia - mostrar primer resultado
                primer = resultados_encontrados[0]
                mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                mensaje += f"Resultado encontrado con DNI {entrada}:\n"
                mensaje += f"CUIL: {primer['cuil']}\n"
                mensaje += f"NOMBRE: {primer['nombre']}\n"
                mensaje += f"NACIMIENTO: {primer['fecha']}"
                return (mensaje, "NO_MATCH", None)
            else:
                # Sin filtro, retornar el primer resultado
                primer = resultados_encontrados[0]
                return (primer["cuil"], primer["nombre"], primer["fecha"]) # <--- RETORNO CON FECHA
    
    except Exception as e:
        return (f"Error al consultar AFIP: {str(e)}", "ERROR", None)