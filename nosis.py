# -*- coding: utf-8 -*-
import unicodedata
import os
import asyncio
from typing import Optional, Tuple
from playwright.async_api import async_playwright
from dotenv import load_dotenv

# Cargar variables de entorno
load_dotenv()

NOSIS_URL = "https://informes.nosis.com/?source=SitioNosis&q=&UrlReferer="

# Path a la extensión Buster (descargada localmente)
BUSTER_EXTENSION_PATH = os.path.join(os.path.dirname(__file__), "buster-extension")


def _norm(s: str) -> str:
    """Normaliza texto removiendo acentos y convirtiendo a minúsculas"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return " ".join(s.lower().split())


def _norm(s: str) -> str:
    """Normaliza texto removiendo acentos y convirtiendo a minúsculas"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return " ".join(s.lower().split())


async def wait_for_captcha_solve(page, max_wait=60) -> bool:
    """
    Espera a que Buster resuelva el captcha automáticamente
    
    Args:
        page: Página de Playwright
        max_wait: Tiempo máximo de espera en segundos
        
    Returns:
        True si se resolvió, False si timeout
    """
    print(f"🤖 Esperando a que Buster resuelva el captcha (máx {max_wait}s)...")
    
    for i in range(max_wait):
        await asyncio.sleep(1)
        
        # Verificar si el captcha desapareció (se resolvió)
        captcha_container = await page.query_selector('#contenedorCaptcha')
        if captcha_container:
            is_hidden = await page.evaluate('(element) => element.style.display === "none"', captcha_container)
            if is_hidden:
                print(f"✅ Captcha resuelto por Buster en {i+1} segundos!")
                return True
        
        # También verificar si aparecieron resultados
        results = await page.query_selector('div.result.row')
        if results:
            print(f"✅ Resultados aparecieron - captcha resuelto en {i+1} segundos!")
            return True
        
        if (i + 1) % 5 == 0:
            print(f"   Esperando... {i+1}s transcurridos")
    
    print(f"❌ Timeout esperando resolución del captcha")
    return False


async def nosis_lookup(dni: str, nombre_filtro: str = None) -> Tuple[Optional[str], Optional[str]]:
    print(f"\n{'='*60}")
    print(f"DEBUG NOSIS_LOOKUP - Inicio")
    print(f"  DNI recibido: '{dni}'")
    print(f"  Nombre filtro recibido: '{nombre_filtro}'")
    print(f"{'='*60}")
    
    # Inicializar variables para el finally block
    context = None
    user_data_dir = None
    
    dni = (dni or '').strip()
    print(f"DEBUG: DNI después de strip: '{dni}'")
    
    # Validar entrada
    if not dni.isdigit():
        print(f"DEBUG: DNI inválido - no es numérico")
        print(f"{'='*60}\n")
        return None, None
    
    # Detectar si es CUIL de 11 dígitos o DNI de 7-9
    es_cuil = len(dni) == 11
    es_dni = 7 <= len(dni) <= 9
    
    if not (es_dni or es_cuil):
        print(f"DEBUG: Longitud inválida - debe ser DNI (7-9) o CUIL (11 dígitos)")
        print(f"{'='*60}\n")
        return None, None
    
    # Si es CUIL, extraer DNI para la búsqueda
    dni_busqueda = dni
    if es_cuil:
        dni_busqueda = dni[2:10]  # Quitar primeros 2 dígitos y último dígito
        print(f"DEBUG: CUIL detectado, extrayendo DNI para búsqueda: {dni_busqueda}")
    
    # Normalizar nombre de filtro si existe
    nombre_filtro_norm = None
    if nombre_filtro:
        print(f"DEBUG: Nombre filtro normalizado: '{nombre_filtro_norm}'")
    else:
        print(f"DEBUG: No hay filtro de nombre")
    
    # Crear directorio temporal para el perfil de usuario (debe estar antes del async with)
    import tempfile
    user_data_dir = tempfile.mkdtemp(prefix='playwright_')
    
    async with async_playwright() as p:
        print(f"DEBUG: Iniciando navegador con contexto persistente...")
        
        # Configurar opciones del navegador con optimizaciones
        browser_args = [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-gpu',
            # NUEVOS ARGS OPTIMIZADOS PARA HEADLESS:
            '--single-process',  # Reduce memoria en headless
            '--disable-background-timer-throttling',  # Performance
            '--disable-backgrounding-occluded-windows',  # Performance
            '--disable-renderer-backgrounding',  # Performance
            '--disable-ipc-flooding-protection',  # Speed
            '--password-store=basic',  # Menos overhead
            '--use-mock-keychain',  # Menos overhead
        ]
        
        # Si existe la extensión Buster, cargarla
        if os.path.exists(BUSTER_EXTENSION_PATH):
            print(f"DEBUG: Cargando extensión Buster desde {BUSTER_EXTENSION_PATH}")
            browser_args.append(f'--disable-extensions-except={BUSTER_EXTENSION_PATH}')
            browser_args.append(f'--load-extension={BUSTER_EXTENSION_PATH}')
        else:
            print(f"⚠️ ADVERTENCIA: Extensión Buster no encontrada en {BUSTER_EXTENSION_PATH}")
            print(f"⚠️ Los captchas no podrán resolverse automáticamente")
        
        # Usar launch_persistent_context que soporta extensiones en headless
        context = await p.chromium.launch_persistent_context(
            user_data_dir,
            headless=True,  # Ahora funciona con extensiones
            args=browser_args,
            timeout=30000  # 30 segundos timeout
        )
        
        page = await context.new_page()
        
        # BLOQUEO DE RECURSOS PARA AHORRAR MEMORIA Y ANCHO DE BANDA
        await page.route("**/*", lambda route: (
            route.abort() if route.request.resource_type in ["image", "stylesheet", "font", "media"]
            else route.continue_()
        ))
        
        try:
            print(f"DEBUG: Navegando a {NOSIS_URL}")
            await page.goto(NOSIS_URL, timeout=60000)
            
            # Verificar si hay CAPTCHA inmediatamente visible
            captcha_container = await page.query_selector('#contenedorCaptcha')
            recaptcha_div = await page.query_selector('div.g-recaptcha')
            
            captcha_visible = False
            if captcha_container:
                is_visible = await page.evaluate('(element) => element.style.display !== "none"', captcha_container)
                captcha_visible = is_visible
            
            if captcha_visible or recaptcha_div:
                print(f"DEBUG: ⚠️ CAPTCHA DETECTADO en página inicial")
                
                # Si tenemos Buster, solo esperar a que lo resuelva
                if os.path.exists(BUSTER_EXTENSION_PATH):
                    solved = await wait_for_captcha_solve(page, max_wait=60)
                    if not solved:
                        print(f"DEBUG: Buster no pudo resolver el captcha - Abortando")
                        print(f"{'='*60}\n")
                        await context.close()
                        return (None, None)
                else:
                    print(f"DEBUG: Extensión Buster no encontrada - Abortando")
                    print(f"DEBUG: Instala Buster en: {BUSTER_EXTENSION_PATH}")
                    print(f"{'='*60}\n")
                    await context.close()
                    return (None, None)
            
            print(f"DEBUG: Esperando que el campo de búsqueda esté visible...")
            await page.wait_for_selector("#Busqueda_Texto", timeout=10000)
            
            print(f"DEBUG: Llenando campo de búsqueda con DNI: {dni_busqueda}")
            await page.fill("#Busqueda_Texto", dni_busqueda)
            await page.press("#Busqueda_Texto", "Enter")
            
            print(f"DEBUG: Esperando resultados (div.result.row)...")
            try:
                await page.wait_for_selector("div.result.row", timeout=30000)
            except Exception as wait_error:
                print(f"DEBUG: ⚠️ Timeout esperando resultados")
                
                # Verificar si apareció captcha después del submit
                captcha_container = await page.query_selector('#contenedorCaptcha')
                recaptcha_div = await page.query_selector('div.g-recaptcha')
                
                captcha_visible = False
                if captcha_container:
                    is_visible = await page.evaluate('(element) => element.style.display !== "none"', captcha_container)
                    captcha_visible = is_visible
                
                if captcha_visible or recaptcha_div:
                    print(f"DEBUG: ⚠️ CAPTCHA apareció después del submit")
                    
                    # Si tenemos Buster, esperar a que lo resuelva
                    if os.path.exists(BUSTER_EXTENSION_PATH):
                        solved = await wait_for_captcha_solve(page, max_wait=60)
                        if solved:
                            print(f"DEBUG: ✓ Captcha resuelto por Buster")
                        else:
                            print(f"DEBUG: Buster no pudo resolver el captcha")
                            raise wait_error
                    else:
                        print(f"DEBUG: Extensión Buster no encontrada")
                        raise wait_error
                else:
                    # No es captcha, es otro error
                    print(f"DEBUG: Guardando screenshot y HTML para análisis...")
                    
                    try:
                        await page.screenshot(path="nosis_error.png", full_page=True)
                        print(f"DEBUG: Screenshot guardado en nosis_error.png")
                    except:
                        pass
                    
                    try:
                        html_content = await page.content()
                        with open("nosis_error.html", "w", encoding="utf-8") as f:
                            f.write(html_content)
                        print(f"DEBUG: HTML guardado en nosis_error.html")
                    except:
                        pass
                    
                    raise wait_error
            
            # Obtener todos los divs de resultados
            result_divs = await page.query_selector_all("div.result.row")
            
            print(f"DEBUG: Encontrados {len(result_divs)} divs de resultados")
            
            if not result_divs:
                print(f"DEBUG: No se encontraron resultados - retornando None")
                print(f"{'='*60}\n")
                return (None, None)
            
            # Procesar todos los resultados
            todos_cuils = []
            todos_nombres = []
            
            print(f"DEBUG: Procesando todos los resultados...")
            for i, result_div in enumerate(result_divs):
                # Buscar CUIL dentro del div (puede estar en span.cuit o similar)
                cuil_element = await result_div.query_selector(".cuit")
                nombre_element = await result_div.query_selector(".rz")
                
                if cuil_element and nombre_element:
                    cuil_text = await cuil_element.text_content()
                    nombre_text = await nombre_element.text_content()
                    
                    print(f"DEBUG: Resultado {i+1}:")
                    print(f"  CUIL raw: '{cuil_text}'")
                    print(f"  Nombre raw: '{nombre_text}'")
                    
                    if cuil_text and nombre_text:
                        cuil_clean = cuil_text.strip()
                        nombre_clean = nombre_text.strip()
                        
                        # Filtrar templates HTML (placeholders no reemplazados)
                        if '@cuit@' in cuil_clean or '@razonsocial@' in nombre_clean:
                            print(f"  ✗ Descartado - es un template HTML, no datos reales")
                            continue
                        
                        todos_cuils.append(cuil_clean)
                        todos_nombres.append(nombre_clean)
                        print(f"  ✓ Agregado - CUIL: '{cuil_clean}', Nombre: '{nombre_clean}'")
                    else:
                        print(f"  ✗ Descartado - texto vacío")
                else:
                    print(f"DEBUG: Resultado {i+1}: No se encontraron elementos .cuit o .rz dentro del div")
            
            print(f"DEBUG: Total procesados: {len(todos_cuils)} resultados")
            
            if not todos_cuils or not todos_nombres:
                print(f"DEBUG: No hay resultados válidos después de procesar")
                print(f"{'='*60}\n")
                return (None, None)
            
            # Si hay filtro de nombre, buscar coincidencias
            if nombre_filtro_norm:
                print(f"DEBUG: Aplicando filtro de nombre: '{nombre_filtro_norm}'")
                resultado_cuils = []
                resultado_nombres = []
                
                for i in range(len(todos_cuils)):
                    nombre_norm = _norm(todos_nombres[i])
                    print(f"DEBUG: Comparando filtro '{nombre_filtro_norm}' con '{nombre_norm}'")
                    
                    if nombre_filtro_norm in nombre_norm:
                        resultado_cuils.append(todos_cuils[i])
                        resultado_nombres.append(todos_nombres[i])
                        print(f"  ✓ COINCIDENCIA encontrada")
                    else:
                        print(f"  ✗ No coincide")
                
                print(f"DEBUG: Coincidencias con filtro: {len(resultado_cuils)}")
                
                # Si no hay coincidencias, mostrar mensaje + todos los resultados
                if not resultado_cuils:
                    print(f"DEBUG: Sin coincidencias - generando mensaje con todos los resultados")
                    mensaje = f"❌ No se encontraron coincidencias con '{nombre_filtro}'\n\n"
                    mensaje += f"📋 Todos los resultados para DNI {dni}:\n\n"
                    
                    for i in range(len(todos_cuils)):
                        mensaje += f"CUIL {i+1}: {todos_cuils[i]}\n"
                        mensaje += f"NOMBRE {i+1}: {todos_nombres[i]}"
                        if i < len(todos_cuils) - 1:
                            mensaje += "\n\n"
                    
                    print(f"DEBUG: Retornando NO_MATCH_SHOWING_ALL")
                    print(f"{'='*60}\n")
                    return (mensaje, "NO_MATCH_SHOWING_ALL")
                
                # Si hay coincidencias con el filtro
                num_resultados = len(resultado_cuils)
                print(f"DEBUG: Generando respuesta con {num_resultados} coincidencia(s)")
                
                if num_resultados == 1:
                    mensaje = f"✅ SE ENCONTRÓ 1 CUIL CON '{nombre_filtro}':\n\n"
                    mensaje += f"CUIL: {resultado_cuils[0]}\n"
                    mensaje += f"NOMBRE: {resultado_nombres[0]}"
                    print(f"DEBUG: Retornando FILTERED_SINGLE")
                    print(f"{'='*60}\n")
                    return (mensaje, "FILTERED_SINGLE")
                
                mensaje = f"✅ SE ENCONTRARON {num_resultados} CUILS CON '{nombre_filtro}':\n\n"
                
                for i in range(num_resultados):
                    mensaje += f"CUIL {i+1}: {resultado_cuils[i]}\n"
                    mensaje += f"NOMBRE {i+1}: {resultado_nombres[i]}"
                    if i < num_resultados - 1:
                        mensaje += "\n\n"
                
                print(f"DEBUG: Retornando FILTERED_MULTIPLE")
                print(f"{'='*60}\n")
                return (mensaje, "FILTERED_MULTIPLE")
            
            # Sin filtro de nombre - mostrar todos
            print(f"DEBUG: Sin filtro - mostrando todos los {len(todos_cuils)} resultados")
            
            if len(todos_cuils) == 1:
                print(f"DEBUG: Un solo resultado - retornando tupla simple")
                print(f"  CUIL: {todos_cuils[0]}")
                print(f"  Nombre: {todos_nombres[0]}")
                print(f"{'='*60}\n")
                return (todos_cuils[0], todos_nombres[0])
            
            num_resultados = len(todos_cuils)
            mensaje = f"SE ENCONTRARON {num_resultados} CUIL{'S' if num_resultados > 1 else ''}:\n\n"
            
            for i in range(num_resultados):
                mensaje += f"CUIL {i+1}: {todos_cuils[i]}\n"
                mensaje += f"NOMBRE {i+1}: {todos_nombres[i]}"
                if i < num_resultados - 1:
                    mensaje += "\n\n"
            
            print(f"DEBUG: Retornando MULTIPLE_RESULTS")
            print(f"{'='*60}\n")
            return (mensaje, "MULTIPLE_RESULTS")
            
        except Exception as e:
            print(f"\n{'!'*60}")
            print(f"ERROR en nosis_lookup: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            print(f"{'!'*60}\n")
            return (None, None)
        finally:
            if context:
                print(f"DEBUG: Cerrando contexto y navegador...")
                try:
                    await context.close()
                    print(f"DEBUG: Contexto cerrado exitosamente")
                except Exception as close_error:
                    print(f"ERROR cerrando contexto: {close_error}")
                
                # Limpiar directorio temporal
                try:
                    import shutil
                    shutil.rmtree(user_data_dir, ignore_errors=True)
                except:
                    pass
            else:
                print(f"DEBUG: No hay contexto para cerrar")
