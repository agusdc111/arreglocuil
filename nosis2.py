# -*- coding: utf-8 -*-
import httpx
from bs4 import BeautifulSoup
import re
import unicodedata

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Referer': 'https://www.google.com/'
}

def limpiar(t):
    """Limpia y normaliza texto"""
    if not t: 
        return ""
    for b in ["()", "VER DETALLES DE", "CONSTANCIA DE CUIL", "VER INFORME COMPLETO", "»", "•"]:
        t = t.replace(b, "")
    return " ".join(t.split()).strip().upper()

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
            # Costo de insercion, eliminacion o sustitucion
            inserciones = fila_anterior[j + 1] + 1
            eliminaciones = fila_actual[j] + 1
            sustituciones = fila_anterior[j] + (c1 != c2)
            fila_actual.append(min(inserciones, eliminaciones, sustituciones))
        fila_anterior = fila_actual
    
    return fila_anterior[-1]

def _coincide_flexible(filtro: str, nombre: str) -> bool:
    """
    Verifica si el filtro coincide con el nombre de forma flexible.
    Acepta coincidencias parciales y errores minimos (hasta 2 caracteres de diferencia).
    Ejemplos: JONATAN=JONATHAN, CARRISO=CARRIZO
    """
    if not filtro or not nombre:
        return False
    
    filtro = filtro.lower()
    nombre = nombre.lower()
    
    # Coincidencia exacta contenida
    if filtro in nombre:
        return True
    
    # Verificar cada palabra del nombre
    palabras_nombre = nombre.split()
    for palabra in palabras_nombre:
        # Si la palabra es muy corta (<=3), debe coincidir exactamente o estar contenida
        if len(filtro) <= 3:
            if filtro == palabra[:len(filtro)] or filtro in palabra:
                return True
            continue
        
        # Coincidencia por contenido
        if filtro in palabra or palabra in filtro:
            return True
        
        # Usar distancia de Levenshtein para palabras similares
        # Permitir hasta 2 errores (1 para palabras cortas, 2 para largas)
        max_errores = 1 if len(filtro) <= 6 else 2
        
        # Comparar con la palabra completa
        if _distancia_levenshtein(filtro, palabra) <= max_errores:
            return True
        
        # Comparar con el inicio de la palabra (mismo largo que el filtro)
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

def calcular_cuits(dni):
    """Calcula los posibles CUIT/CUIL a partir de un DNI"""
    candidatos = []
    for pre in [20, 27, 23]:
        cadena = f"{pre}{str(dni).zfill(8)}"
        factores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
        suma = sum(int(cadena[i]) * factores[i] for i in range(10))
        resto = suma % 11
        dv = 0 if resto == 0 else (9 if resto == 1 and pre == 23 else (None if resto == 1 else 11 - resto))
        if dv is not None:
            candidatos.append({'fmt': f"{pre}-{str(dni).zfill(8)}-{dv}", 'num': f"{pre}{str(dni).zfill(8)}{dv}"})
    return candidatos

async def info_cuitonline_search_cuil(cuil):
    """Consulta CuitOnline por CUIL exacto (11 dígitos)"""
    url = f"https://www.cuitonline.com/search.php?q={cuil}"
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            r = await client.get(url, headers=HEADERS)
            soup = BeautifulSoup(r.text, 'html.parser')
            
            hits = soup.find_all("div", class_="hit")
            if not hits:
                return []
            
            resultados = []
            for hit in hits:
                datos = {}
                nombre_tag = hit.find(["h2", "h3"], class_="denominacion")
                if nombre_tag: 
                    datos["NOMBRE"] = limpiar(nombre_tag.get_text())
                
                cuit_tag = hit.find("span", class_="cuit")
                if cuit_tag: 
                    datos["CUIT"] = limpiar(cuit_tag.get_text())
                
                if datos.get("NOMBRE") and datos.get("CUIT"):
                    resultados.append(datos)
            
            return resultados
    except: 
        return []

async def info_cuitonline_search(dni):
    """Consulta CuitOnline por DNI - retorna lista de resultados"""
    url = f"https://www.cuitonline.com/search.php?q={dni}"
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            r = await client.get(url, headers=HEADERS)
            soup = BeautifulSoup(r.text, 'html.parser')
            
            # Buscar todos los resultados (múltiples hits)
            hits = soup.find_all("div", class_="hit")
            if not hits:
                return []
            
            resultados = []
            for hit in hits:
                datos = {}
                nombre_tag = hit.find(["h2", "h3"], class_="denominacion")
                if nombre_tag: 
                    datos["NOMBRE"] = limpiar(nombre_tag.get_text())
                
                cuit_tag = hit.find("span", class_="cuit")
                if cuit_tag: 
                    datos["CUIT"] = limpiar(cuit_tag.get_text())
                
                if datos.get("NOMBRE") and datos.get("CUIT"):
                    resultados.append(datos)
            
            return resultados
    except: 
        return []

async def info_sistemas360(dni):
    """Consulta Sistemas360 (AFIP)"""
    url = "https://sistemas360.ar/cuitonline"
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            r_get = await client.get(url, headers=HEADERS)
            soup_get = BeautifulSoup(r_get.text, 'html.parser')
            token_input = soup_get.find("input", {"name": "_token"})
            if not token_input:
                return None
            token = token_input.get('value')
            
            r_post = await client.post(url, data={'cuit': dni, '_token': token}, headers=HEADERS)
            soup = BeautifulSoup(r_post.text, 'html.parser')
            nombre = soup.find("span", class_="fw-bold text-dark")
            if not nombre: 
                return None
            
            datos = {"NOMBRE": limpiar(nombre.get_text())}
            for tr in soup.find_all("tr"):
                th, td = tr.find("th"), tr.find("td")
                if th and td:
                    clave = limpiar(th.get_text())
                    valor = limpiar(td.get_text())
                    datos[clave] = valor
                    if clave == "CUIT": 
                        datos["CUIT"] = valor
            return datos
    except: 
        return None

async def info_dateas(cuit_num):
    """Consulta Dateas para datos del padrón electoral"""
    url = f"https://www.dateas.com/es/persona/cuit-{cuit_num}"
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
            r = await client.get(url, headers=HEADERS)
            soup = BeautifulSoup(r.text, 'html.parser')
            tabla = soup.find("table", class_="entity-table")
            if not tabla: 
                return None
            datos = {}
            for tr in tabla.find_all("tr"):
                th, td = tr.find("th"), tr.find("td")
                if th and td:
                    if td.find("button"): 
                        td.find("button").decompose()
                    clave = limpiar(th.get_text())
                    valor = limpiar(td.get_text())
                    datos[clave] = valor
                    if "APELLIDO Y NOMBRE" in clave: 
                        datos["NOMBRE"] = valor
                    if "CUIT/CUIL" in clave: 
                        datos["CUIT"] = valor
            return datos
    except: 
        return None

async def nosis2_lookup(dni_o_cuil: str, nombre_filtro: str = None):
    """
    Consulta múltiples fuentes para obtener NOMBRE y CUIL consolidados.
    Consulta: CuitOnline, Sistemas360 (AFIP), Dateas.
    
    Args:
        dni_o_cuil: DNI (7-9 dígitos) o CUIL (11 dígitos, con o sin guiones)
                    Ejemplos: "47156273", "20471562735", "20-47156273-5"
        nombre_filtro: Nombre parcial para filtrar resultados (opcional, acepta errores mínimos)
    
    Returns:
        Tupla (cuil, nombre) - el CUIL siempre sin guiones
        Si no hay coincidencia con el nombre, retorna mensaje con todos los resultados
    """
    # Limpiar input (quitar guiones, espacios)
    dni_o_cuil = (dni_o_cuil or '').strip().replace("-", "").replace(" ", "")
    
    # Validar que sea numérico
    if not dni_o_cuil.isdigit():
        return ("Input inválido", "ERROR")
    
    # Detectar si es DNI o CUIL
    es_cuil = len(dni_o_cuil) == 11
    es_dni = 7 <= len(dni_o_cuil) <= 9
    
    if not (es_dni or es_cuil):
        return ("Longitud inválida. Debe ser DNI (7-9) o CUIL (11 dígitos)", "ERROR")
    
    # Normalizar filtro de nombre si existe
    nombre_filtro_norm = None
    if nombre_filtro:
        nombre_filtro_norm = _norm(nombre_filtro.strip())
    
    # Diccionario de identidad consolidado
    id_final = {"NOMBRE": "NO IDENTIFICADO", "CUIT": "NO IDENTIFICADO"}
    
    # CASO 1: Es un CUIL (11 dígitos) - No calcular variantes
    if es_cuil:
        # Buscar directamente por el CUIL
        resultados_co = await info_cuitonline_search_cuil(dni_o_cuil)
        
        if resultados_co:
            # Si hay filtro de nombre, buscar coincidencia
            if nombre_filtro_norm:
                for res in resultados_co:
                    nombre_norm = _norm(res.get("NOMBRE", ""))
                    if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        id_final["NOMBRE"] = res["NOMBRE"]
                        id_final["CUIT"] = res["CUIT"]
                        break
                
                # Si no hubo coincidencia, mostrar mensaje + primer resultado
                if id_final["NOMBRE"] == "NO IDENTIFICADO":
                    primer_resultado = resultados_co[0]
                    mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                    mensaje += f"CUIL: {primer_resultado['CUIT'].replace('-', '')}\n"
                    mensaje += f"NOMBRE: {primer_resultado['NOMBRE']}"
                    return (mensaje, "NO_MATCH")
            else:
                # Sin filtro, usar el primer resultado
                id_final["NOMBRE"] = resultados_co[0]["NOMBRE"]
                id_final["CUIT"] = resultados_co[0]["CUIT"]
        
        # Intentar Sistemas360 si no encontramos
        if id_final["NOMBRE"] == "NO IDENTIFICADO":
            s360 = await info_sistemas360(dni_o_cuil)
            if s360:
                # Si hay filtro de nombre, verificar coincidencia
                if nombre_filtro_norm:
                    nombre_norm = _norm(s360["NOMBRE"])
                    if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        id_final["NOMBRE"] = s360["NOMBRE"]
                        if s360.get("CUIT"):
                            id_final["CUIT"] = s360["CUIT"]
                    else:
                        # No coincide, retornar NO_MATCH
                        mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                        mensaje += f"CUIL: {dni_o_cuil}\n"
                        mensaje += f"NOMBRE: {s360['NOMBRE']}"
                        return (mensaje, "NO_MATCH")
                else:
                    # Sin filtro, usar el resultado
                    id_final["NOMBRE"] = s360["NOMBRE"]
                    if s360.get("CUIT"):
                        id_final["CUIT"] = s360["CUIT"]
        
        # Intentar Dateas con el CUIL exacto
        if id_final["NOMBRE"] == "NO IDENTIFICADO" or id_final["CUIT"] == "NO IDENTIFICADO":
            d_da = await info_dateas(dni_o_cuil)
            if d_da:
                # Si hay filtro de nombre, verificar coincidencia
                if nombre_filtro_norm and id_final["NOMBRE"] == "NO IDENTIFICADO":
                    nombre_norm = _norm(d_da.get("NOMBRE", ""))
                    if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        if id_final["NOMBRE"] == "NO IDENTIFICADO": 
                            id_final["NOMBRE"] = d_da.get("NOMBRE", "NO IDENTIFICADO")
                        if id_final["CUIT"] == "NO IDENTIFICADO": 
                            id_final["CUIT"] = d_da.get("CUIT", dni_o_cuil)
                    else:
                        # No coincide, retornar NO_MATCH
                        mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                        mensaje += f"CUIL: {dni_o_cuil}\n"
                        mensaje += f"NOMBRE: {d_da.get('NOMBRE', 'NO IDENTIFICADO')}"
                        return (mensaje, "NO_MATCH")
                else:
                    # Sin filtro o ya tenemos nombre, usar el resultado
                    if id_final["NOMBRE"] == "NO IDENTIFICADO": 
                        id_final["NOMBRE"] = d_da.get("NOMBRE", "NO IDENTIFICADO")
                    if id_final["CUIT"] == "NO IDENTIFICADO": 
                        id_final["CUIT"] = d_da.get("CUIT", dni_o_cuil)
        
        # Si no se encontró nada con CUIL directo, extraer DNI y buscar con variantes
        if id_final["NOMBRE"] == "NO IDENTIFICADO" or id_final["CUIT"] == "NO IDENTIFICADO":
            print(f"[NOSIS2] No se encontró CUIL {dni_o_cuil} directo, extrayendo DNI...")
            dni_extraido = dni_o_cuil[2:10]  # Quitar primeros 2 dígitos y último dígito
            # Continuar con búsqueda por DNI (convertir es_cuil a False para forzar CASO 2)
            es_cuil = False
            dni_o_cuil = dni_extraido
    
    # CASO 2: Es un DNI (7-9 dígitos O extraído de CUIL) - Calcular variantes
    if not es_cuil:
        # 1. CUITONLINE SEARCH (retorna lista de resultados)
        resultados_co = await info_cuitonline_search(dni_o_cuil)
        
        # Si hay filtro de nombre, buscar coincidencia flexible
        if nombre_filtro_norm and resultados_co:
            coincidencias = []
            for res in resultados_co:
                nombre_norm = _norm(res.get("NOMBRE", ""))
                if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                    coincidencias.append(res)
            
            if coincidencias:
                # Usar la primera coincidencia
                id_final["NOMBRE"] = coincidencias[0]["NOMBRE"]
                id_final["CUIT"] = coincidencias[0]["CUIT"]
            else:
                # No hubo coincidencias - mostrar mensaje + primer resultado
                if resultados_co:
                    primer_resultado = resultados_co[0]
                    mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                    mensaje += f"CUIL: {primer_resultado['CUIT'].replace('-', '')}\n"
                    mensaje += f"NOMBRE: {primer_resultado['NOMBRE']}"
                    return (mensaje, "NO_MATCH")
        elif resultados_co:
            # Sin filtro, usar el primer resultado
            id_final["NOMBRE"] = resultados_co[0]["NOMBRE"]
            id_final["CUIT"] = resultados_co[0]["CUIT"]
        
        # 2. SISTEMAS360 (AFIP) - solo si no encontramos datos en CuitOnline
        if id_final["NOMBRE"] == "NO IDENTIFICADO":
            s360 = await info_sistemas360(dni_o_cuil)
            if s360:
                # Si hay filtro de nombre, verificar coincidencia
                if nombre_filtro_norm:
                    nombre_norm = _norm(s360["NOMBRE"])
                    if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                        id_final["NOMBRE"] = s360["NOMBRE"]
                        if s360.get("CUIT"):
                            id_final["CUIT"] = s360["CUIT"]
                    else:
                        # No coincide, retornar NO_MATCH
                        mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                        mensaje += f"Resultado encontrado con DNI {dni_o_cuil}:\n"
                        mensaje += f"CUIL: {s360.get('CUIT', 'NO IDENTIFICADO').replace('-', '')}\n"
                        mensaje += f"NOMBRE: {s360['NOMBRE']}"
                        return (mensaje, "NO_MATCH")
                else:
                    # Sin filtro, usar el resultado
                    id_final["NOMBRE"] = s360["NOMBRE"]
                    if s360.get("CUIT"):
                        id_final["CUIT"] = s360["CUIT"]
        
        # 3. DATEAS (Padrón Electoral) - solo si aún no tenemos datos
        if id_final["NOMBRE"] == "NO IDENTIFICADO" or id_final["CUIT"] == "NO IDENTIFICADO":
            cuits_posibles = calcular_cuits(dni_o_cuil)
            for c in cuits_posibles:
                d_da = await info_dateas(c['num'])
                if d_da:
                    # Si hay filtro de nombre, verificar coincidencia
                    if nombre_filtro_norm and id_final["NOMBRE"] == "NO IDENTIFICADO":
                        nombre_norm = _norm(d_da.get("NOMBRE", ""))
                        if _coincide_flexible(nombre_filtro_norm, nombre_norm):
                            if id_final["NOMBRE"] == "NO IDENTIFICADO": 
                                id_final["NOMBRE"] = d_da.get("NOMBRE", "NO IDENTIFICADO")
                            if id_final["CUIT"] == "NO IDENTIFICADO": 
                                id_final["CUIT"] = d_da.get("CUIT", c['num'])
                            break
                        else:
                            # No coincide pero guardamos para mostrar si no hay mejor opción
                            if id_final["NOMBRE"] == "NO IDENTIFICADO":
                                # Guardar primer resultado no coincidente
                                mensaje = f"⚠️ No se encontró coincidencia con '{nombre_filtro}'\n\n"
                                mensaje += f"CUIL: {c['num']}\n"
                                mensaje += f"NOMBRE: {d_da.get('NOMBRE', 'NO IDENTIFICADO')}"
                                return (mensaje, "NO_MATCH")
                    else:
                        # Sin filtro o ya tenemos nombre, usar el resultado
                        if id_final["NOMBRE"] == "NO IDENTIFICADO": 
                            id_final["NOMBRE"] = d_da.get("NOMBRE", "NO IDENTIFICADO")
                        if id_final["CUIT"] == "NO IDENTIFICADO": 
                            id_final["CUIT"] = d_da.get("CUIT", c['num'])  # Usar 'num' sin guiones
                        break
    
    # Limpiar guiones del CUIL antes de retornar
    cuil_sin_guiones = id_final['CUIT'].replace("-", "")
    
    # Retornar tupla (cuil, nombre) como espera el bot
    return (cuil_sin_guiones, id_final['NOMBRE'])
