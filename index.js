import { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } from 'discord.js'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Obtener __dirname en módulos ES
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ═══════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

// Cargar variables de entorno desde .env si existe
const envPath = path.join(__dirname, '.env')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8')
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=')
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=')
        process.env[key.trim()] = value.trim()
      }
    }
  })
}

const DISCORD_TOKEN = process.env.DISCORD_TOKEN
const CORE = process.env.CORE_API_URL || "http://127.0.0.1:9000"
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL
// IDs de canales permitidos (separados por comas desde .env)
const ALLOWED_CHANNEL_IDS = process.env.ALLOWED_CHANNEL_IDS
  ? process.env.ALLOWED_CHANNEL_IDS.split(',').map(id => id.trim())
  : []

// Canal para reacciones automáticas por líneas
const CALL_CHANNEL_ID = process.env.CALL_CHANNEL_ID ? process.env.CALL_CHANNEL_ID.trim() : null

// Configuración CALI
const CALI_METODO_PRIMARIO = process.env.CALI_METODO_PRIMARIO || "nosis3"
const CALI_METODO_SECUNDARIO = CALI_METODO_PRIMARIO === "nosis3" ? "nosis2" : "nosis3"

// Validar token
if (!DISCORD_TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN no está configurado')
  console.error('Por favor, crea un archivo .env basándote en .env.example')
  process.exit(1)
}

// ═══════════════════════════════════════════════════════════════
// CARGAR ALIAS DE OBRAS SOCIALES
// ═══════════════════════════════════════════════════════════════

let aliasObrasSociales = {}
try {
  const aliasPath = path.join(__dirname, 'alias_obras_sociales.json')
  const aliasData = fs.readFileSync(aliasPath, 'utf8')
  aliasObrasSociales = JSON.parse(aliasData).alias
  console.log(`✓ Cargados ${Object.keys(aliasObrasSociales).length} alias de obras sociales`)
} catch (e) {
  console.warn('⚠ No se pudo cargar alias_obras_sociales.json, usando nombres completos')
}

// ═══════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES
// ═══════════════════════════════════════════════════════════════

/**
 * Normaliza texto removiendo acentos y caracteres especiales
 * Maneja secuencias mal codificadas comunes (Ã³ → o, Ã± → n, etc.)
 */
function normalizarTexto(texto) {
  if (!texto) return ""
  
  // Mapa de secuencias mal codificadas (más común a menos común)
  const reemplazos = {
    // Mayúsculas con acento
    'Ó': 'O',
    'Á': 'A',
    'É': 'E', 
    'Í': 'I',
    'Ú': 'U',
    'Ñ': 'N',
    // Minúsculas con acento
    'ó': 'o',
    'á': 'a',
    'é': 'e',
    'í': 'i',
    'ú': 'u',
    'ñ': 'n',
    // Otros caracteres problemáticos
    'Â': '',
    'Ã': '',
    '': ''
  }
  
  let normalizado = texto
  
  // Aplicar reemplazos de secuencias primero
  for (const [mal, bien] of Object.entries(reemplazos)) {
    normalizado = normalizado.split(mal).join(bien)
  }
  
  // Luego normalizar con NFD para acentos restantes
  normalizado = normalizado.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  
  // Remover cualquier carácter no-ASCII que quede
  normalizado = normalizado.replace(/[^\x00-\x7F]/g, '')
  
  return normalizado.trim()
}

/**
 * Aplica alias cortos a nombres de obras sociales
 * Busca primero el nombre EXACTO como viene de la web (con acentos),
 * si no encuentra, retorna el nombre original sin modificar
 */
function aplicarAlias(nombreObraSocial) {
  if (!nombreObraSocial) return nombreObraSocial
  
  // PRIMERO: Buscar alias con el nombre EXACTO como viene de la web (con acentos y todo)
  if (aliasObrasSociales[nombreObraSocial]) {
    return aliasObrasSociales[nombreObraSocial]
  }
  
  // Si no hay alias, retornar el nombre ORIGINAL tal cual vino (sin normalizar)
  return nombreObraSocial
}

/**
 * Divide texto largo en chunks que no excedan el límite de Discord (2000 chars)
 */
function dividirMensaje(texto, maxLength = 2000) {
  if (texto.length <= maxLength) return [texto]
  
  const chunks = []
  let current = ''
  
  const lines = texto.split('\n')
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) chunks.push(current)
      current = line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  
  if (current) chunks.push(current)
  return chunks
}

// ═══════════════════════════════════════════════════════════════
// HEARTBEAT A HEALTHCHECKS.IO
// ═══════════════════════════════════════════════════════════════

if (HEALTHCHECK_URL) {
  // 270000 ms = 4 min 30 s (entra holgado en Period=5 min con Grace=3)
  setInterval(() => {
    fetch(HEALTHCHECK_URL).catch(() => {})
  }, 270000)
  console.log('✓ Heartbeat configurado')
}

// ═══════════════════════════════════════════════════════════════
// TEXTO DE AYUDA
// ═══════════════════════════════════════════════════════════════

const HELP = `📋 **COMANDOS DISPONIBLES**

🔹 **cali <DNI> <NOMBRE>**
   Búsqueda completa (Nosis + Aportes + SSS + CODEM)
   Ejemplo: cali 47156273 agustin

🔹 **calimono / monocali <DNI> [NOMBRE]**
   Verificación unificada de monotributistas (MONOPAGO + MONOTRAS)
   Ejemplos: calimono 47156273 | monocali 47156273 agustin

🔹 **DESEMPLEADO**
   **LISTA DE CUILS**
   Chequea lista de desempleados en ARCA y CODEM
   Ejemplo: DESEMPLEADO
	    20471562735
	    27112233445

🔹 **codem <DNI|CUIL>**
   Consulta situación CODEM/ANSES
   Ejemplo: codem 47156273

🔹 **nosis <DNI|CUIL> [NOMBRE]**
   Consulta AFIP A13
   Ejemplo: nosis 47156273

🔹 **nosis2 <DNI|CUIL> [NOMBRE]**
   Consulta rápida de nosis 
   Ejemplo: nosis2 47156273

🔹 **nosis3 <DNI|CUIL> [NOMBRE]**
   Consulta AFIP A13 (alias de nosis)
   Ejemplo: nosis3 47156273

🔹 **arca <CUIL>**
   Consulta detallada de aportes
   Ejemplo: arca 20471562733

🔹 **sss <DNI|CUIL>**
   Consulta traspasos y padrón SSS
   Ejemplo: sss 47156273

🔹 **monopago <DNI|CUIL>**
   Últimos pagos de monotributo (SSS)
   Ejemplos: monopago 27-26116939-3 | monopago 27261169393 | monopago 47156273

🔹 **monotras / monosss <DNI|CUIL>**
   Traspasos y evolución de monotributo (SSS)
   Ejemplos: monotras 47156273 | monosss 20-18354323-8

🔹 **blanco <CUIL>**
   Consulta trabajo registrado en AFIP (altas y bajas)
   Ejemplo: blanco 20471562733

━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Tip: Los comandos funcionan con o sin **!** (signo de exclamación)`

// ═══════════════════════════════════════════════════════════════
// CREAR CLIENTE DE DISCORD
// ═══════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// ═══════════════════════════════════════════════════════════════
// EVENTO: BOT LISTO
// ═══════════════════════════════════════════════════════════════

client.once('clientReady', () => {
  console.log('✅ Bot conectado como:', client.user.tag)
  console.log(`📡 Conectado a ${client.guilds.cache.size} servidor(es)`)
  
  console.log(`🔒 Bot configurado para ${ALLOWED_CHANNEL_IDS.length} canales específicos`)
  ALLOWED_CHANNEL_IDS.forEach((id, index) => {
    const canal = client.channels.cache.get(id)
    const nombreCanal = canal ? `#${canal.name}` : '(canal no encontrado)'
    console.log(`   ${index + 1}. ${nombreCanal} - ID: ${id}`)
  })
  
  // Validar canal de reacciones
  if (CALL_CHANNEL_ID) {
    const canalReacciones = client.channels.cache.get(CALL_CHANNEL_ID)
    if (canalReacciones) {
      console.log(`📞 Canal de reacciones: #${canalReacciones.name} - ID: ${CALL_CHANNEL_ID}`)
    } else {
      console.warn(`⚠️ ADVERTENCIA: CALL_CHANNEL_ID configurado (${CALL_CHANNEL_ID}) pero canal no encontrado`)
    }
  } else {
    console.warn('⚠️ CALL_CHANNEL_ID no configurado - Sistema de reacciones deshabilitado')
  }
  
  console.log(`⚙️ Método CALI primario: ${CALI_METODO_PRIMARIO}`)
  console.log(`⚙️ API: ${CORE}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✓ Bot operativo')
})

// ═══════════════════════════════════════════════════════════════
// EVENTO: MENSAJE RECIBIDO
// ═══════════════════════════════════════════════════════════════

client.on('messageCreate', async (message) => {
  // Ignorar mensajes del propio bot
  if (message.author.bot) return

  // ═══════════════════════════════════════════════════════════════
  // SISTEMA DE REACCIONES AUTOMÁTICAS POR LÍNEAS
  // ═══════════════════════════════════════════════════════════════
  
  if (CALL_CHANNEL_ID && message.channelId === CALL_CHANNEL_ID) {
    try {
      const contenido = message.content.trim()
      if (contenido) {
        const numLineas = contenido.split('\n').length
        
        if (numLineas >= 22) {
          await message.react('✅')
        } else if (numLineas >= 11 && numLineas <= 21) {
          await message.react('⚠️')
        }
      }
    } catch (error) {
      console.error(`❌ Error al reaccionar en canal ${CALL_CHANNEL_ID}:`, error.message)
    }
    
    // No procesar como comando si es solo el canal de reacciones
    // (a menos que también esté en ALLOWED_CHANNEL_IDS)
    if (!ALLOWED_CHANNEL_IDS.includes(message.channelId)) {
      return
    }
  }

  // Solo responder comandos en canales permitidos
  if (!ALLOWED_CHANNEL_IDS.includes(message.channelId)) return

  // Ignorar mensajes vacíos
  let t = message.content.trim()
  if (!t) return
  
  // ═══════════════════════════════════════════════════════════════
  // LIMPIEZA DE SÍMBOLOS NO DESEADOS
  // ═══════════════════════════════════════════════════════════════
  
  /**
   * Limpia símbolos no deseados al inicio y final de cada línea
   * Ejemplos:  ", ', `, -, _, *, etc.
   */
  function limpiarLinea(linea) {
    if (!linea) return ""
    // Remover símbolos comunes al inicio y final (preservando espacios internos)
    return linea.replace(/^[\"\'\`\-_\*\.\,\;\:\!\¡\¿\?\~\+\=\[\]\{\}\(\)\<\>\|\\\/\s]+|[\"\'\`\-_\*\.\,\;\:\!\¡\¿\?\~\+\=\[\]\{\}\(\)\<\>\|\\\/\s]+$/g, '').trim()
  }
  
  // Detectar formato CIERRE y convertirlo a formato cali
  const lineas = t.split('\n')
    .map(l => limpiarLinea(l))  // Limpiar cada línea
    .filter(l => l)              // Remover líneas vacías
  
  // Función auxiliar para validar y limpiar DNI/CUIL
  function validarYLimpiarDniCuil(texto) {
    if (!texto) return null
    // Limpiar guiones
    const limpio = texto.replace(/\-/g, '')
    // Validar: solo 8 dígitos (DNI) u 11 dígitos (CUIL)
    if (limpio.match(/^(\d{8}|\d{11})$/)) {
      return limpio
    }
    return null
  }
  
  // Función auxiliar para detectar si una línea contiene "cierre" y "mono"
  function esCierreMono(texto) {
    if (!texto) return false
    const textoLimpio = texto.toUpperCase().replace(/\s+/g, '')
    return textoLimpio.includes('CIERRE') && textoLimpio.includes('MONO')
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FORMATO CIERRE MONO / MONO CIERRE (VERIFICAR PRIMERO)
  // ═══════════════════════════════════════════════════════════════
  
  // Variables para parseo de CIERRE MONO
  let dniCierreMono = null
  let nombreCierreMono = null
  
  // Formato 1: Multilinea - Primera línea es "CIERRE MONO" (o variantes)
  if (lineas.length >= 2 && esCierreMono(lineas[0])) {
    if (lineas.length === 2) {
      // CIERRE MONO\nDNI
      const dniLimpio = validarYLimpiarDniCuil(lineas[1])
      if (dniLimpio) {
        dniCierreMono = dniLimpio
        nombreCierreMono = null
      } else {
        await message.reply(`❌ **Formato CIERRE MONO incorrecto**\n\nSi usas 2 líneas, la segunda debe ser un DNI (8 dígitos) o CUIL (11 dígitos).\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5`)
        return
      }
    } else if (lineas.length === 3) {
      // CIERRE MONO\nXXX\nYYY - detectar cuál es DNI
      const linea2Limpia = validarYLimpiarDniCuil(lineas[1])
      const linea3Limpia = validarYLimpiarDniCuil(lineas[2])
      
      if (linea2Limpia && !linea3Limpia) {
        // CIERRE MONO\nDNI\nNOMBRE
        dniCierreMono = linea2Limpia
        nombreCierreMono = lineas[2]
      } else if (!linea2Limpia && linea3Limpia) {
        // CIERRE MONO\nNOMBRE\nDNI
        nombreCierreMono = lineas[1]
        dniCierreMono = linea3Limpia
      } else if (linea2Limpia && linea3Limpia) {
        // Ambos son DNI -> usar el primero
        dniCierreMono = linea2Limpia
        nombreCierreMono = null
      } else {
        // Ninguno es DNI -> formato inválido
        await message.reply(`❌ **Formato CIERRE MONO incorrecto**\n\nNo se detectó un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5`)
        return
      }
    }
  }
  // Formato 2: Inline - "CIERRE MONO XXX" o "MONO CIERRE XXX" (o variantes)
  else if (lineas.length === 1 && esCierreMono(lineas[0])) {
    // Extraer todo lo que no sea "cierre" o "mono"
    const palabras = lineas[0].split(/\s+/)
    const partsNoComando = palabras.filter(p => {
      const pUpper = p.toUpperCase()
      return pUpper !== 'CIERRE' && pUpper !== 'MONO'
    })
    
    if (partsNoComando.length === 0) {
      // Solo "CIERRE MONO" sin argumentos -> formato incorrecto
      await message.reply(`❌ **Formato CIERRE MONO incorrecto**\n\nDebes proporcionar al menos un DNI o CUIL.\n\n💡 Ejemplos válidos:\n  CIERRE MONO\n  47156273\n\n  MONO CIERRE\n  GARCIA JUAN\n  20471562735`)
      return
    } else if (partsNoComando.length === 1) {
      // Solo un argumento -> debe ser DNI
      const dniLimpio = validarYLimpiarDniCuil(partsNoComando[0])
      if (dniLimpio) {
        dniCierreMono = dniLimpio
        nombreCierreMono = null
      } else {
        await message.reply(`❌ **Formato CIERRE MONO incorrecto**\n\n"${partsNoComando[0]}" no es un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5`)
        return
      }
    } else {
      // Múltiples argumentos -> detectar cuál es DNI
      let dniIndex = -1
      let dniLimpio = null
      for (let i = 0; i < partsNoComando.length; i++) {
        const testDni = validarYLimpiarDniCuil(partsNoComando[i])
        if (testDni) {
          dniIndex = i
          dniLimpio = testDni
          break
        }
      }
      
      if (dniIndex === -1) {
        await message.reply(`❌ **Formato CIERRE MONO incorrecto**\n\nNo se detectó un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5`)
        return
      }
      
      // Extraer DNI y nombre (todo lo demás)
      dniCierreMono = dniLimpio
      const nombreParts = [...partsNoComando.slice(0, dniIndex), ...partsNoComando.slice(dniIndex + 1)]
      nombreCierreMono = nombreParts.length > 0 ? nombreParts.join(' ') : null
    }
  }
  
  // Aplicar transformación si se detectó formato CIERRE MONO válido
  if (dniCierreMono) {
    if (nombreCierreMono) {
      t = `!calimono ${dniCierreMono} ${nombreCierreMono}`
    } else {
      t = `!calimono ${dniCierreMono}`
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FORMATO CIERRE (SOLO SI NO ES CIERRE MONO)
  // ═══════════════════════════════════════════════════════════════
  
  // Variables para parseo
  let dniCierre = null
  let nombreCierre = null
  
  // Solo procesar CIERRE si NO se procesó CIERRE MONO
  if (!dniCierreMono) {
    // Formato 1: Solo "CIERRE" -> Mostrar ayuda
    if (lineas.length === 1 && lineas[0].toUpperCase() === 'CIERRE') {
      await message.reply(`📋 **FORMATO CIERRE**

**Formatos válidos:**

🔹 **Multilínea con nombre:**
   CIERRE
   NOMBRE
   DNI/CUIL

🔹 **Multilinea DNI primero:**
   CIERRE
   DNI/CUIL
   NOMBRE

🔹 **Multilinea solo DNI:**
   CIERRE
   DNI/CUIL

🔹 **Inline solo DNI:**
   CIERRE DNI/CUIL

🔹 **Inline con nombre (cualquier orden):**
   CIERRE NOMBRE DNI/CUIL
   CIERRE DNI/CUIL NOMBRE

━━━━━━━━━━━━━━━━━━━━
💡 **Ejemplos válidos:**

   CIERRE
   GARCIA JUAN
   20304050

   CIERRE
   20304050
   GARCIA JUAN

   CIERRE
   20304050

   CIERRE 20304050

   CIERRE GARCIA JUAN 20304050

   CIERRE 20304050 GARCIA JUAN`)
      return
    }
    
    // Formato 2: CIERRE\nDNI (sin nombre - 2 líneas)
    if (lineas.length === 2 && lineas[0].toUpperCase() === 'CIERRE') {
      const dniLimpio = validarYLimpiarDniCuil(lineas[1])
      if (dniLimpio) {
        dniCierre = dniLimpio
        nombreCierre = null
      } else {
        // Línea 2 no es DNI -> formato inválido
        await message.reply(`❌ **Formato CIERRE incorrecto**\n\nSi usas 2 líneas, la segunda debe ser un DNI (8 dígitos) o CUIL (11 dígitos).\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5\n\n💡 Usa **CIERRE** (sin argumentos) para ver todos los formatos válidos.`)
        return
      }
    }
    // Formato 3: CIERRE\nXXX\nYYY (3 líneas - detectar cuál es DNI)
    else if (lineas.length === 3 && lineas[0].toUpperCase() === 'CIERRE') {
      const linea2Limpia = validarYLimpiarDniCuil(lineas[1])
      const linea3Limpia = validarYLimpiarDniCuil(lineas[2])
      
      if (linea2Limpia && !linea3Limpia) {
        // Formato: CIERRE\nDNI\nNOMBRE
        dniCierre = linea2Limpia
        nombreCierre = lineas[2]
      } else if (!linea2Limpia && linea3Limpia) {
        // Formato: CIERRE\nNOMBRE\nDNI
        nombreCierre = lineas[1]
        dniCierre = linea3Limpia
      } else if (linea2Limpia && linea3Limpia) {
        // Ambos son DNI -> formato ambiguo, usar el primero
        dniCierre = linea2Limpia
        nombreCierre = null
      } else {
        // Ninguno es DNI -> formato inválido
        await message.reply(`❌ **Formato CIERRE incorrecto**\n\nNo se detectó un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5\n\n💡 Usa **CIERRE** (sin argumentos) para ver todos los formatos válidos.`)
        return
      }
    }
    // Formato 4: CIERRE XXX YYY ... (inline con argumentos, pero NO CIERRE MONO)
    else if (lineas.length === 1 && lineas[0].toUpperCase().startsWith('CIERRE ') && !esCierreMono(lineas[0])) {
      const parts = lineas[0].split(/\s+/).slice(1) // Remover "CIERRE"
      
      if (parts.length === 0) {
        // "CIERRE " sin argumentos -> ya manejado arriba
        await message.reply(`❌ **Formato CIERRE incorrecto**\n\n💡 Usa **CIERRE** (sin argumentos) para ver todos los formatos válidos.`)
        return
      } else if (parts.length === 1) {
        // CIERRE XXX -> XXX debe ser DNI
        const dniLimpio = validarYLimpiarDniCuil(parts[0])
        if (dniLimpio) {
          dniCierre = dniLimpio
          nombreCierre = null
        } else {
          await message.reply(`❌ **Formato CIERRE incorrecto**\n\n"${parts[0]}" no es un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5\n\n💡 Usa **CIERRE** (sin argumentos) para ver todos los formatos válidos.`)
          return
        }
      } else {
        // CIERRE XXX YYY ZZZ... -> detectar cuál es DNI
        let dniIndex = -1
        let dniLimpio = null
        for (let i = 0; i < parts.length; i++) {
          const testDni = validarYLimpiarDniCuil(parts[i])
          if (testDni) {
            dniIndex = i
            dniLimpio = testDni
            break
          }
        }
        
        if (dniIndex === -1) {
          await message.reply(`❌ **Formato CIERRE incorrecto**\n\nNo se detectó un DNI (8 dígitos) o CUIL (11 dígitos) válido.\n\n💡 Ejemplos válidos:\n  • DNI: 47156273\n  • CUIL: 20471562735 o 20-47156273-5\n\n💡 Usa **CIERRE** (sin argumentos) para ver todos los formatos válidos.`)
          return
        }
        
        // Extraer DNI y nombre (todo lo demás)
        dniCierre = dniLimpio
        const nombreParts = [...parts.slice(0, dniIndex), ...parts.slice(dniIndex + 1)]
        nombreCierre = nombreParts.length > 0 ? nombreParts.join(' ') : null
      }
    }
  } // Fin del bloque if (!dniCierreMono)
  
  // Aplicar transformación si se detectó formato CIERRE válido
  if (dniCierre) {
    if (nombreCierre) {
      t = `!cali ${dniCierre} ${nombreCierre}`
    } else {
      t = `!cali ${dniCierre}`
    }
  }
  
  // Detectar si tiene prefijo ! o no
  const tienePrefix = t.startsWith('!')
  const textoSinPrefix = tienePrefix ? t.slice(1) : t
  
  // Parsear comando y argumentos
  const [cmd, ...rest] = textoSinPrefix.split(/\s+/)
  const arg = rest.join(' ').trim()
  const low = cmd.toLowerCase()
  
  // Lista de comandos válidos (para evitar responder a cualquier mensaje)
  const comandosValidos = ['ping', 'help', 'ayuda', 'codem', 'nosis', 'nosis2', 'nosis3', 'arca', 'arcaprueba', 'aportes', 'sss', 'monopago', 'monotras', 'monosss', 'blanco', 'cali', 'calimono', 'monocali', 'desempleado', 'nuevomono']
  if (!comandosValidos.includes(low)) return
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: PING
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'ping') {
    const t0 = Date.now()
    const msg = await message.reply('pong')
    const ms = Date.now() - t0
    await msg.edit(`pong\nlatencia: ${ms} ms`)
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: HELP / AYUDA
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'help' || low === 'ayuda') {
    await message.reply(HELP)
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: CODEM
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'codem') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  codem <DNI|CUIL>\n\n💡 Ejemplos:\n  codem 47156273\n  codem 20471562733`)
      return
    }
    
    await message.reply('Consultando CODEM...')
    
    try {
      const r = await fetch(`${CORE}/codem?doc=${encodeURIComponent(arg)}`)
      const body = await r.text()
      
      if (!r.ok) {
        await message.reply(`❌ Error del servidor: ${body}`)
        return
      }
      
      // Verificar si es RECHAZO (PASIVO, MONOTRIBUTISTA, Familiar o Sin Resultados)
      let mensaje = body.slice(0, 4000)
      const esPasivo = /Situación:\s*PASIVO/i.test(mensaje)
      const esMonotributista = /Situación:\s*MONOTRIBUTISTA/i.test(mensaje)
      const esFamiliar = /Condición:\s*Familiar/i.test(mensaje)
      const sinResultados = /La consulta no arrojó resultados\./i.test(mensaje)
      
      if (esPasivo || esMonotributista || esFamiliar || sinResultados) {
        mensaje = `-=-=-=⚠️RECHAZO⚠️=-=-=-\n\n${mensaje}`
      }
      
      // Dividir mensaje si es muy largo
      const chunks = dividirMensaje(mensaje)
      for (const chunk of chunks) {
        await message.channel.send(chunk)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: NOSIS (Nosis.com scraping)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'nosis') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  nosis <DNI> [NOMBRE]\n\n💡 Ejemplos:\n  nosis 47156273\n  nosis 47156273 agustin`)
      return
    }
    
    // Parsear DNI y nombre
    const parts = arg.split(/\s+/)
    let dni = ""
    let nombre = ""
    
    for (const part of parts) {
      const cleaned = part.replace(/\-/g, "")
      if (cleaned.match(/^\d{7,9}$/)) {
        dni = cleaned
      } else {
        nombre += (nombre ? " " : "") + part
      }
    }
    
    if (!dni) {
      await message.reply(`❌ Debe proporcionar un DNI válido (7-9 dígitos)`)
      return
    }
    
    // Mensaje de procesamiento
    const statusMsg = await message.reply(`🔍 Chequeando en Nosis.com...`)
    
    try {
      let url = `${CORE}/nosis?dni=${encodeURIComponent(dni)}`
      if (nombre) {
        url += `&nombre=${encodeURIComponent(nombre)}`
      }
      
      const r = await fetch(url)
      const data = await r.json()
      
      if (!data.ok) {
        await statusMsg.edit(`❌ No se pudo obtener información de Nosis.com`)
        return
      }
      
      await statusMsg.edit(`CUIL: ${data.cuil}\nNOMBRE: ${data.nombre}`)
    } catch (e) {
      await statusMsg.edit(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: NOSIS2
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'nosis2') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  nosis2 <DNI|CUIL> [NOMBRE]\n\n💡 Ejemplos:\n  nosis2 47156273\n  nosis2 20471562733\n  nosis2 47156273 agustin`)
      return
    }
    
    // Parsear DNI y nombre opcional
    const parts = arg.split(/\s+/)
    let dni = ""
    let nombre = ""
    
    for (const part of parts) {
      const cleaned = part.replace(/\-/g, "")
      if (cleaned.match(/^\d{7,11}$/)) {
        dni = cleaned
      } else {
        nombre += (nombre ? " " : "") + part
      }
    }
    
    if (!dni) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  nosis2 <DNI> [NOMBRE]\n\n💡 Ejemplos:\n  nosis2 47156273\n  nosis2 47156273 agustin`)
      return
    }
    
    await message.reply('Buscando en CuitOnline...')
    
    try {
      let url = `${CORE}/nosis2?dni=${encodeURIComponent(dni)}`
      if (nombre) {
        url += `&nombre=${encodeURIComponent(nombre)}`
      }
      
      const r = await fetch(url)
      const data = await r.json()
      
      if (!data.ok) {
        await message.reply(`❌ No se pudo obtener información`)
        return
      }
      
      if (data.nombre === "MULTIPLE_RESULTS" || data.nombre === "NO_MATCH" || 
          data.nombre === "NO_MATCH_SHOWING_ALL" || data.nombre === "FILTERED_SINGLE" || 
          data.nombre === "FILTERED_MULTIPLE") {
        await message.reply(data.cuil)
      } else {
        await message.reply(`CUIL: ${data.cuil}\nNombre: ${data.nombre}`)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: NOSIS3
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'nosis3') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  nosis3 <DNI|CUIL> [NOMBRE]\n\n💡 Ejemplos:\n  nosis3 47156273\n  nosis3 20471562733\n  nosis3 47156273 agustin`)
      return
    }
    
    // Parsear DNI/CUIL y nombre opcional
    const parts = arg.split(/\s+/)
    let dni = ""
    let nombre = ""
    
    for (const part of parts) {
      const cleaned = part.replace(/\-/g, "")
      if (cleaned.match(/^\d{7,11}$/)) {
        dni = cleaned
      } else {
        nombre += (nombre ? " " : "") + part
      }
    }
    
    if (!dni) {
      await message.reply(`❌ Debe proporcionar un DNI o CUIL válido`)
      return
    }
    
    await message.reply('Consultando AFIP A13...')
    
    try {
      let url = `${CORE}/nosis3?dni=${encodeURIComponent(dni)}`
      if (nombre) {
        url += `&nombre=${encodeURIComponent(nombre)}`
      }
      
      const r = await fetch(url)
      const data = await r.json()
      
      if (!data.ok) {
        await message.reply(`❌ No se pudo obtener información`)
        return
      }
      
      if (data.nombre === "ERROR") {
        await message.reply(`❌ ${data.cuil}\n\n💡 Intenta nuevamente o usa el comando **nosis2**`)
        return
      }
      
      if (data.nombre && data.nombre.includes("⚠️ No se encontró coincidencia")) {
        await message.reply(data.cuil)
      } else {
        const fechaNac = data.fecha_nacimiento || "S/D"
        await message.reply(`CUIL: ${data.cuil}\nNOMBRE: ${data.nombre}\nNACIMIENTO: ${fechaNac}`)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: ARCA (ARCAPRUEBA)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'arca' || low === 'arcaprueba' || low === 'aportes') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  arca <CUIL>\n\n💡 Ejemplo:\n  arca 20471562733`)
      return
    }
    
    await message.reply('Consultando AFIP (Mis Aportes)...')
    
    try {
      const r = await fetch(`${CORE}/arca?cuil=${encodeURIComponent(arg)}`)
      const data = await r.json()
      
      if (!data.ok) {
        await message.reply(`${data.error}`)
        return
      }
      
      // Enviar imágenes como attachments
      for (const img of data.images) {
        const buf = Buffer.from(img.png_base64, 'base64')
        const attachment = new AttachmentBuilder(buf, { name: 'aportes.png' })
        await message.channel.send({
          content: img.caption,
          files: [attachment]
        })
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: SSS
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'sss') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  sss <DNI o CUIL>\n\n💡 Ejemplos:\n  sss 47156273\n  sss 20471562733`)
      return
    }
    
    await message.reply('🔍 Consultando SSS (esto puede tardar ~15 segundos)...')
    
    try {
      const url = `${CORE}/sss?cuil_o_dni=${encodeURIComponent(arg)}`
      const r = await fetch(url)
      const data = await r.json()
      
      if (!data.ok) {
        // Verificar si es error de web caída
        if (data.error === "WEB_CAIDA") {
          await message.reply("⚠️ La web de SSS está caída o no responde. Intenta más tarde.")
        } else {
          await message.reply(`❌ ${data.error || 'Error desconocido'}`)
        }
        return
      }
      
      let mensaje = ""
      
      if (data.tipo === "traspasos") {
        const cuil = data.cuil
        const traspasos = data.datos
        
        if (!traspasos || traspasos.length === 0) {
          mensaje = `📋 **CUIL: ${cuil}**\n\nℹ️ No se encontraron traspasos registrados`
        } else {
          mensaje = `📋 **TRASPASOS - CUIL: ${cuil}**\n`
          
          const campoMap = {
            "período desde": "Desde",
            "periodo desde": "Desde",
            "período hasta": "Hasta",
            "periodo hasta": "Hasta",
            "código movimiento": "Movimiento",
            "codigo movimiento": "Movimiento",
            "obra social elegida": "Obra Social Elegida",
            "estado": "Estado"
          }
          
          const camposOmitir = ["código registro", "codigo registro"]
          
          for (let i = 0; i < traspasos.length; i++) {
            mensaje += `\n**Traspaso #${i+1}**\n`
            const traspaso = traspasos[i]
            for (const [key, value] of Object.entries(traspaso)) {
              const keyLower = key.toLowerCase().trim()
              
              if (camposOmitir.includes(keyLower)) {
                continue
              }
              
              const keyDisplay = campoMap[keyLower] || key
              mensaje += `• ${keyDisplay}: ${value}\n`
            }
          }
          
          mensaje = mensaje.trimEnd()
        }
      } else if (data.tipo === "padron") {
        const cuil = data.cuil
        const obraSocial = data.obra_social || "No disponible"
        const fechaAlta = data.fecha_alta || "No disponible"
        
        if (obraSocial === "No disponible" && fechaAlta === "No disponible") {
          mensaje = `No se reportan datos para el CUIL: ${cuil}`
        } else {
          mensaje = `📋 **PADRÓN DE BENEFICIARIOS**\n\n`
          mensaje += `**CUIL:** ${cuil}\n`
          mensaje += `**Obra Social:** ${obraSocial}\n`
          mensaje += `**Fecha de Alta:** ${fechaAlta}`
        }
      } else {
        mensaje = "❌ Tipo de resultado desconocido"
      }
      
      const chunks = dividirMensaje(mensaje)
      for (const chunk of chunks) {
        await message.channel.send(chunk)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: MONOPAGO
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'monopago') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  monopago <DNI o CUIL>\n\n💡 Ejemplos:\n  monopago 27-26116939-3\n  monopago 27261169393\n  monopago 47156273`)
      return
    }
    
    await message.reply('🔍 Consultando pagos de monotributo (puede tardar ~5s)...')
    
    try {
      const r = await fetch(`${CORE}/mono_pagos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cuil: arg })
      })
      const data = await r.json()
      
      if (!data.ok) {
        await message.reply(`❌ ${data.error || 'Error desconocido'}`)
        return
      }
      
      const nombre = data.nombre || 'NO IDENTIFICADO'
      const periodos = data.periodos || []
      let texto = `✅ PAGOS MONOTRIBUTO\n\n👤 ${nombre}\n\n📅 PERIODOS:\n`
      if (periodos.length === 0) {
        texto += '• Sin registros\n'
      } else {
        for (const p of periodos) {
          texto += `• ${p}\n`
        }
      }
      await message.reply(texto)
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: MONOTRAS / MONOSSS
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'monotras' || low === 'monosss') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  monotras <DNI o CUIL>\n\n💡 Ejemplos:\n  monotras 47156273\n  monosss 20-18354323-8`)
      return
    }
    
    await message.reply('🔍⚡ Consultando traspasos de monotributo')
    
    try {
      const r = await fetch(`${CORE}/monotras`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cuil: arg })
      })
      const data = await r.json()
      
      if (!data.ok) {
        await message.reply(`❌ ${data.error || 'Error desconocido'}`)
        return
      }
      
      const nombre = data.nombre || 'NO IDENTIFICADO'
      const situacion = data.situacion || 'No disponible'
      const categoria = data.categoria || 'No disponible'
      const evolucion = data.evolucion || []
      
      let texto = `✅ MONOTRIBUTISTA SSS\n\n`
      texto += `👤 ${nombre}\n`
      texto += `📊 Situación: ${situacion}\n`
      texto += `📋 Categoría: ${categoria}\n\n`
      
      if (evolucion.length > 0) {
        texto += `📅 EVOLUCIÓN DEL PADRÓN:\n\n`
        for (let i = 0; i < evolucion.length; i++) {
          const ev = evolucion[i]
          texto += `• ${ev.periodo_inicio} → ${ev.periodo_fin}\n`
          texto += `  ${ev.obra_social}\n\n`
        }
      } else {
        texto += `📅 Sin registros de evolución\n`
      }
      
      // Dividir si es muy largo
      const chunks = dividirMensaje(texto)
      for (const chunk of chunks) {
        await message.channel.send(chunk)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: BLANCO (ARCA - Trabajo Registrado)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'blanco') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  blanco <CUIL o DNI>\n\n💡 Ejemplo:\n  blanco 20471562733\n  blanco 47156273`)
      return
    }
    
    // Validar que sean solo números y que tengan 8 u 11 dígitos
    const argClean = arg.replace(/\D/g, '')
    if (argClean.length !== 8 && argClean.length !== 11) {
      await message.reply(`❌ **Formato incorrecto**\n\n📝 Debe ingresar:\n  • DNI de 8 dígitos, o\n  • CUIL de 11 dígitos\n\n💡 Ejemplo:\n  blanco 20471562733\n  blanco 47156273`)
      return
    }
    
    await message.reply('🔍 Consultando AFIP TREB (esto puede tardar ~15-30 segundos)...')
    
    try {
      let cuilToUse = argClean
      
      // Si el argumento tiene 8 dígitos (DNI), buscar CUIL internamente
      if (/^\d{8}$/.test(argClean)) {
        // Intentar obtener CUIL desde nosis3, nosis2, o nosis
        let cuilFound = null
        
        // Intentar nosis3
        try {
          const r3 = await fetch(`${CORE}/nosis3?dni=${encodeURIComponent(argClean)}`)
          const d3 = await r3.json()
          if (d3.ok && d3.cuil) {
            cuilFound = d3.cuil
          }
        } catch (e) {
          // Continuar con nosis2
        }
        
        // Si no se encontró, intentar nosis2
        if (!cuilFound) {
          try {
            const r2 = await fetch(`${CORE}/nosis2?dni=${encodeURIComponent(argClean)}`)
            const d2 = await r2.json()
            if (d2.ok && d2.cuil) {
              cuilFound = d2.cuil
            }
          } catch (e) {
            // Continuar con nosis
          }
        }
        
        // Si no se encontró, intentar nosis
        if (!cuilFound) {
          try {
            const r1 = await fetch(`${CORE}/nosis?dni=${encodeURIComponent(argClean)}`)
            const d1 = await r1.json()
            if (d1.ok && d1.cuil) {
              cuilFound = d1.cuil
            }
          } catch (e) {
            // No se pudo obtener CUIL
          }
        }
        
        if (cuilFound) {
          cuilToUse = cuilFound
        } else {
          await message.reply(`❌ No se pudo obtener el CUIL para el DNI ${argClean}. Intenta con el CUIL completo.`)
          return
        }
      }
      
      const url = `${CORE}/blanco?cuil=${encodeURIComponent(cuilToUse)}`
      const r = await fetch(url)
      const data = await r.json()
      
      if (!data.ok) {
        // Verificar si es error de web caída
        if (data.error === "WEB_CAIDA") {
          await message.reply("⚠️ El servicio Trabajo en blanco de AFIP está caído o no responde. Intenta más tarde.")
        } else {
          await message.reply(`❌ ${data.mensaje || data.error || 'Error desconocido'}`)
        }
        return
      }
      
      let mensaje = `📋 **TRABAJO REGISTRADO - CUIL: ${data.cuil}**\n`
      
      // Agregar nombre si está disponible
      if (data.nombre) {
        mensaje += `👤 **${data.nombre}**\n`
      }
      
      mensaje += `\n`
      
      // Sección ALTAS
      mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
      mensaje += `**ALTAS REGISTRADAS ACTIVAS**\n`
      mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
      
      if (data.altas.encontradas && data.altas.cantidad > 0) {
        mensaje += `✅ ${data.altas.cantidad} alta(s) registrada(s)\n`
        if (data.altas.ultima_fecha) {
          mensaje += `📅 Última alta: ${data.altas.ultima_fecha}\n`
        }
        mensaje += `\n`
        
        for (let i = 0; i < data.altas.datos.length; i++) {
          const alta = data.altas.datos[i]
          mensaje += `**Alta #${i+1}**\n`
          for (const [key, value] of Object.entries(alta)) {
            mensaje += `• ${key}: ${value}\n`
          }
          mensaje += `\n`
        }
      } else {
        mensaje += `ℹ️ Sin altas registradas\n\n`
      }
      
      // Sección BAJAS
      mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
      mensaje += `**BAJAS REGISTRADAS (últimos 24 meses)**\n`
      mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
      
      if (data.bajas.encontradas && data.bajas.cantidad > 0) {
        mensaje += `✅ ${data.bajas.cantidad} baja(s) registrada(s)\n`
        if (data.bajas.ultima_fecha) {
          mensaje += `📅 Última baja: ${data.bajas.ultima_fecha}\n`
        }
        mensaje += `\n`
        
        for (let i = 0; i < data.bajas.datos.length; i++) {
          const baja = data.bajas.datos[i]
          mensaje += `**Baja #${i+1}**\n`
          for (const [key, value] of Object.entries(baja)) {
            mensaje += `• ${key}: ${value}\n`
          }
          mensaje += `\n`
        }
      } else {
        mensaje += `ℹ️ Sin bajas registradas\n\n`
      }
      
      // Resumen final
      if (data.resumen) {
        mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
        mensaje += `**RESUMEN**\n`
        mensaje += `━━━━━━━━━━━━━━━━━━━━\n`
        mensaje += `${data.resumen}\n`
      }
      
      const chunks = dividirMensaje(mensaje)
      for (const chunk of chunks) {
        await message.channel.send(chunk)
      }
    } catch (e) {
      await message.reply(`❌ Error de conexión: ${e.message}`)
    }
    return
  }
  
  // ═══════════════════════════════════════════════════════════════
  // COMANDO: CALI (FLUJO COMPLETO)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'cali') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  cali <DNI|CUIL> <NOMBRE>\n\n💡 Ejemplos:\n  cali 47156273 agustin\n  cali 20471562733 agustin\n  cali agustin 47156273`)
      return
    }
    
    let dni = ""
    let nombre = ""
    
    // Parsear DNI y nombre (pueden venir en cualquier orden)
    const parts = arg.split(/\s+/)
    
    for (const part of parts) {
      const cleaned = part.replace(/\-/g, "")
      if (cleaned.match(/^\d{7,11}$/)) {
        dni = cleaned
      } else {
        nombre += (nombre ? " " : "") + part
      }
    }
    
    if (!dni) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  cali <DNI> [NOMBRE]\n\n💡 Ejemplos:\n  cali 47156273 agustin\n  cali agustin 47156273\n  cali 47156273`)
      return
    }
    
    // Validar que sea DNI (8 dígitos) o CUIL (11 dígitos)
    if (dni.length !== 8 && dni.length !== 11) {
      await message.reply(`❌ **Formato inválido**\n\n📝 Debe ingresar:\n  • DNI de 8 dígitos, o\n  • CUIL de 11 dígitos (con o sin guiones)\n\n💡 Ejemplos:\n  cali 47156273\n  cali 20471562735\n  cali 20-47156273-5\n\n⚠️ Ingresaste ${dni.length} dígitos`)
      return
    }
    
    await message.reply(`🔍 Iniciando búsqueda completa para DNI/CUIL ${dni}${nombre ? ' con nombre "' + nombre + '"' : ' (sin nombre)'}...`)
    
    try {
      // ═════════════════════════════════════════════════════════════
      // PASO 1: BUSCAR CON MÉTODO PRIMARIO Y FALLBACK AL SECUNDARIO
      // ═════════════════════════════════════════════════════════════
      
      let cuilParaAportes = null
      let nombreEncontrado = null
      let metodoUsado = null
      let hayAdvertenciaNombre = false
      
      // Intentar con método primario (ahora optimizado para CUIL de 11 dígitos)
      await message.channel.send(`1️⃣ Buscando con ${CALI_METODO_PRIMARIO}...`)
      
      try {
        const url1 = `${CORE}/${CALI_METODO_PRIMARIO}?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
        const res1 = await fetch(url1, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const data1 = await res1.json()
        
        if (data1.ok && data1.nombre === "ERROR") {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO}: ${data1.cuil}`)
        } else if (data1.ok && data1.cuil === "NO IDENTIFICADO") {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no encontró información`)
        } else if (data1.ok && data1.cuil) {
          if (data1.nombre === "NO_MATCH") {
            const cuilMatch = data1.cuil.match(/CUIL:\s*(\d{11})/i)
            if (cuilMatch) {
              cuilParaAportes = cuilMatch[1]
              const nombreMatch = data1.cuil.match(/NOMBRE:\s*(.+?)(?:\n|$)/i)
              nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
              // Extraer fecha de nacimiento si existe
              const fechaMatch = data1.cuil.match(/NACIMIENTO:\s*(.+?)(?:\n|$)/i)
              const fechaNac = fechaMatch ? fechaMatch[1].trim() : (data1.fecha_nacimiento || "S/D")
              metodoUsado = CALI_METODO_PRIMARIO
              hayAdvertenciaNombre = true
              await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaAportes}\n👤 Nombre registrado: ${nombreEncontrado}\n📅 Nacimiento: ${fechaNac}\n\n▶️ Continuando con el flujo de verificación...`)
            } else {
              await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
            }
          } else {
            cuilParaAportes = data1.cuil.replace(/\-/g, '').replace(/\s/g, '')
            nombreEncontrado = data1.nombre
            const fechaNac = data1.fecha_nacimiento || "S/D"
            metodoUsado = CALI_METODO_PRIMARIO
            await message.channel.send(`✅ Encontrado con ${CALI_METODO_PRIMARIO}\n📋 CUIL: ${data1.cuil}\n👤 Nombre: ${data1.nombre}\n📅 Nacimiento: ${fechaNac}`)
          }
        } else {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no pudo obtener datos`)
        }
      } catch (e1) {
        await message.channel.send(`⚠️ Error en ${CALI_METODO_PRIMARIO}: ${e1.message}`)
      }
      
      // Si el método primario falló, intentar con el secundario
      if (!cuilParaAportes) {
        await message.channel.send(`🔄 Intentando con método alternativo: ${CALI_METODO_SECUNDARIO}...`)
        
        try {
          const url2 = `${CORE}/${CALI_METODO_SECUNDARIO}?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
          const res2 = await fetch(url2, {
            headers: { 'X-CALI-Flow': 'true' }
          })
          const data2 = await res2.json()
          
          if (data2.ok && data2.nombre === "ERROR") {
            await message.channel.send(`❌ ${CALI_METODO_SECUNDARIO}: ${data2.cuil}`)
          } else if (data2.ok && data2.cuil === "NO IDENTIFICADO") {
            await message.channel.send(`❌ ${CALI_METODO_SECUNDARIO} no encontró información`)
          } else if (data2.ok && data2.cuil) {
            if (data2.nombre === "NO_MATCH") {
              const cuilMatch = data2.cuil.match(/CUIL:\s*(\d{11})/i)
              if (cuilMatch) {
                cuilParaAportes = cuilMatch[1]
                const nombreMatch = data2.cuil.match(/NOMBRE:\s*(.+?)(?:\n|$)/i)
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = CALI_METODO_SECUNDARIO
                hayAdvertenciaNombre = true
                await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaAportes}\n👤 Nombre registrado: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`⚠️ ${CALI_METODO_SECUNDARIO} tampoco encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
              }
            } else {
              cuilParaAportes = data2.cuil.replace(/\-/g, '').replace(/\s/g, '')
              nombreEncontrado = data2.nombre
              metodoUsado = CALI_METODO_SECUNDARIO
              await message.channel.send(`✅ Encontrado con ${CALI_METODO_SECUNDARIO}\n📋 CUIL: ${data2.cuil}\nNombre: ${data2.nombre}`)
            }
          } else {
            await message.channel.send(`⚠️ ${CALI_METODO_SECUNDARIO} tampoco pudo obtener datos`)
          }
        } catch (e2) {
          await message.channel.send(`⚠️ Error en ${CALI_METODO_SECUNDARIO}: ${e2.message}`)
        }
      }
      
      // Si ambos métodos fallaron, intentar con nosis como último recurso
      if (!cuilParaAportes) {
        // nosis.py solo acepta DNI de 7-9 dígitos, no acepta CUIL (11 dígitos)
        if (dni.length === 11) {
          // Es CUIL - nosis no puede procesar CUILs directamente
          await message.channel.send(`❌ No se pudo obtener información. Nosis.com no puede procesar CUILs directamente`)
        } else {
          await message.channel.send(`🔄 Último intento: Chequeando en Nosis.com...`)
          
          try {
            const url3 = `${CORE}/nosis?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
            const res3 = await fetch(url3, {
              headers: { 'X-CALI-Flow': 'true' }
            })
            const data3 = await res3.json()
          
          if (data3.ok && data3.cuil && !data3.cuil.includes('@cuit@')) {
            // Caso 1: FILTERED_SINGLE - Se encontró 1 coincidencia con el filtro
            if (data3.nombre === "FILTERED_SINGLE") {
              const cuilMatch = data3.cuil.match(/CUIL:\s*(\d{2}-\d{8}-\d{1})/i)
              const nombreMatch = data3.cuil.match(/NOMBRE:\s*(.+?)(?=\n|$)/i)
              if (cuilMatch) {
                cuilParaAportes = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                await message.channel.send(`✅ Encontrado con Nosis.com\n📋 CUIL: ${cuilParaAportes}\n👤 Nombre: ${nombreEncontrado}`)
              } else {
                await message.channel.send(`❌ Error procesando resultado de Nosis.com`)
              }
            }
            // Caso 2: FILTERED_MULTIPLE - Se encontraron múltiples coincidencias
            else if (data3.nombre === "FILTERED_MULTIPLE") {
              const cuilMatch = data3.cuil.match(/CUIL\s+1:\s*(\d{2}-\d{8}-\d{1})/i)
              const nombreMatch = data3.cuil.match(/NOMBRE\s+1:\s*(.+?)(?=\n|$)/i)
              if (cuilMatch) {
                cuilParaAportes = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                hayAdvertenciaNombre = true
                await message.channel.send(`⚠️ Se encontraron múltiples coincidencias. Usando la primera:\n\n📋 CUIL: ${cuilParaAportes}\n👤 Nombre: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`❌ Error procesando resultados múltiples de Nosis.com`)
              }
            }
            // Caso 3: NO_MATCH_SHOWING_ALL - Nombre no coincide, mostrando todos
            else if (data3.nombre === "NO_MATCH_SHOWING_ALL") {
              // Extraer el primer CUIL del mensaje
              const cuilMatch = data3.cuil.match(/CUIL\s+\d+:\s*(\d{2}-\d{8}-\d{1})/i)
              if (cuilMatch) {
                cuilParaAportes = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                // Extraer el primer nombre
                const nombreMatch = data3.cuil.match(/NOMBRE\s+\d+:\s*(.+?)(?=\n|$)/i)
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                hayAdvertenciaNombre = true
                await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaAportes}\n👤 Nombre registrado: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`❌ Nosis.com no encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
              }
            } else {
              // Caso 4: Respuesta directa con nombre coincidente
              cuilParaAportes = data3.cuil.replace(/\-/g, '').replace(/\s/g, '')
              nombreEncontrado = data3.nombre
              metodoUsado = 'nosis'
              await message.channel.send(`✅ Encontrado con Nosis.com\n📋 CUIL: ${data3.cuil}\n👤 Nombre: ${data3.nombre}`)
            }
          } else {
            await message.channel.send(`❌ Nosis.com tampoco pudo obtener datos`)
          }
          } catch (e3) {
            await message.channel.send(`⚠️ Error en Nosis: ${e3.message}`)
          }
        }
      }
      
      // Si ningún método funcionó, detener el proceso
      if (!cuilParaAportes) {
        await message.channel.send(`❌ Todos los métodos fallaron. No se pudo obtener información.`)
        await message.channel.send(`💡 Verifica que el DNI y nombre sean correctos e intenta nuevamente.`)
        return
      }
      
      // ═════════════════════════════════════════════════════════════
      // PASO 2: EJECUTAR ARCA (APORTES AFIP)
      // ═════════════════════════════════════════════════════════════
      
      if (cuilParaAportes && cuilParaAportes.match(/^\d{11}$/)) {
        let tieneAportesValidos = false
        let hayRechazoCodem = false
        let obraSocialInfo = null
        
        await message.channel.send("2️⃣ Consultando aportes AFIP...")
        
        const arcaRes = await fetch(`${CORE}/arca?cuil=${encodeURIComponent(cuilParaAportes)}`, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const arcaData = await arcaRes.json()
        
        // Variable para excepción ARCA
        let hayInclusionEnDDJJ = false
        
        if (arcaData.ok) {
          // Enviar imágenes
          for (const img of arcaData.images) {
            const buf = Buffer.from(img.png_base64, 'base64')
            const attachment = new AttachmentBuilder(buf, { name: 'aportes.png' })
            await message.channel.send({
              content: img.caption,
              files: [attachment]
            })
          }
          
          // Analizar si hay aportes válidos Y verificar estado laboral
          if (arcaData.empleadores_data) {
            // Variables para el nuevo análisis
            let hayEmpleadorActivo = false      // SI en última fila, sin "-"
            let hayEmpleadorEnLicencia = false  // SI en última fila, con "-"
            
            // PRIMER BUCLE: Verificar si hay aportes válidos en cualquier empleador
            for (const emp of arcaData.empleadores_data) {
              if (emp.rows && emp.rows.length > 0) {
                // Verificar si última fila tiene aportes válidos
                const ultimaFila = emp.rows[emp.rows.length - 1]
                const tieneAportes = ultimaFila.some && typeof ultimaFila.some === 'function' ? ultimaFila.some(col => {
                  const val = String(col).trim().toUpperCase()
                  return val !== "" && val !== "-" && val !== "INFORMATIVO"
                }) : Object.values(ultimaFila).some(val => {
                  const v = String(val).trim().toUpperCase()
                  return v !== "" && v !== "-" && v !== "INFORMATIVO"
                })
                
                if (tieneAportes) {
                  tieneAportesValidos = true
                  break
                }
              }
            }
            
            // SEGUNDO BUCLE:  Verificar estado laboral en la ÚLTIMA FILA de cada empleador
            for (const emp of arcaData.empleadores_data) {
              if (emp.rows && emp.rows.length > 0) {
                const ultimaFila = emp.rows[emp.rows.length - 1]
                
                // Obtener valor de columna DDJJ (columna 1 / índice 0 o 1 según estructura)
                let valorDDJJ = null
                let valoresFila = []
                
                if (Array.isArray(ultimaFila)) {
                  // Si es array, columna 1 es índice 1 (índice 0 suele ser período)
                  valorDDJJ = ultimaFila[1]
                  valoresFila = ultimaFila
                } else if (typeof ultimaFila === 'object') {
                  // Si es objeto, buscar por clave
                  valorDDJJ = ultimaFila.ddjj || ultimaFila.DDJJ || ultimaFila['ddjj']
                  valoresFila = Object.values(ultimaFila)
                  
                  // Si no existe por clave, intentar por posición
                  if (!valorDDJJ && valoresFila.length > 1) {
                    valorDDJJ = valoresFila[1]
                  }
                }
                
                // Verificar si tiene "SI" en columna DDJJ
                const tieneSI = valorDDJJ && String(valorDDJJ).toUpperCase().trim() === "SI"
                
                if (tieneSI) {
                  // Verificar si hay "-" en alguna columna de la última fila
                  let tieneGuion = false
                  for (const valor of valoresFila) {
                    if (String(valor).trim() === "-") {
                      tieneGuion = true
                      break
                    }
                  }
                  
                  if (tieneGuion) {
                    hayEmpleadorEnLicencia = true
                  } else {
                    hayEmpleadorActivo = true
                  }
                }
              }
            }
            
            // Guardar estado para uso posterior (excepción CODEM)
            hayInclusionEnDDJJ = hayEmpleadorActivo  // Solo cuenta si está activo (sin "-")
            
            // VERIFICAR CONDICIONES DE CORTE
            if (! hayEmpleadorActivo && !hayEmpleadorEnLicencia) {
              // Ningún empleador tiene "SI" en última fila → DESEMPLEADO
              await message.channel.send("❌Calificacion detenida:  DESEMPLEADO")
              return
            }
            
            if (! hayEmpleadorActivo && hayEmpleadorEnLicencia) {
              // Solo hay empleadores con "SI" pero todos tienen "-" → LICENCIA
              await message.channel.send("❌Calificacion detenida: LICENCIA")
              return
            }
            
            // Si llegamos aquí, hay al menos un empleador activo (SI sin "-")
            // El flujo continúa normalmente
          }
        } else {
          // Verificar si es CASAS PARTICULARES
          if (arcaData.error && arcaData.error.includes("CASAS PARTICULARES")) {
            await message.channel.send(`${arcaData.error}`)
            await message.channel.send("❌ Búsqueda detenida (régimen de aportes no compatible)")
            return
          }
          await message.channel.send(`⚠️ Aportes:  ${arcaData.error}`)
        }
        
        // ═════════════════════════════════════════════════════════════
        // PASO 3: EJECUTAR CODEM
        // ═════════════════════════════════════════════════════════════
        
        await message.channel.send("3️⃣ Consultando CODEM...")
        
        const codemRes = await fetch(`${CORE}/codem?doc=${encodeURIComponent(cuilParaAportes)}`, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const codemData = await codemRes.text()
        
        let mensajeCodem = codemData.slice(0, 4000)
        const esPasivo = /Situación:\s*PASIVO/i.test(mensajeCodem)
        const esMonotributista = /Situación:\s*MONOTRIBUTISTA/i.test(mensajeCodem)
        const esFamiliar = /Condición:\s*Familiar/i.test(mensajeCodem)
        const sinResultados = /La consulta no arrojó resultados\./i.test(mensajeCodem)
        
        if (esPasivo || esMonotributista || esFamiliar || sinResultados) {
          mensajeCodem = `-=-=-=⚠️RECHAZO⚠️=-=-=-\n\n${mensajeCodem}`
          hayRechazoCodem = true
          
          // Excepción: Si hay inclusión en DDJJ, continuar flujo
          if (hayInclusionEnDDJJ) {
            const chunks = dividirMensaje(`📊 Resultado CODEM:\n${mensajeCodem}`)
            for (const chunk of chunks) {
              await message.channel.send(chunk)
            }
            await message.channel.send("⚠️ NOTA: Aunque CODEM indica rechazo, se detectó inclusión en Declaración Jurada en ARCA. Continuando verificación...")
          } else {
            const chunks = dividirMensaje(`📊 Resultado CODEM:\n${mensajeCodem}`)
            for (const chunk of chunks) {
              await message.channel.send(chunk)
            }
            await message.channel.send("❌ Búsqueda detenida por RECHAZO en CODEM. Si crees que es un error, verifica traspasos con **sss <DNI|CUIL>**")
            return
          }
        } else {
          const chunks = dividirMensaje(`📊 Resultado CODEM:\n${mensajeCodem}`)
          for (const chunk of chunks) {
            await message.channel.send(chunk)
          }
        }
        
        // ═════════════════════════════════════════════════════════════
        // PASO 4: EJECUTAR SSS
        // ═════════════════════════════════════════════════════════════
        
        await message.channel.send("4️⃣ Consultando SSS (esto puede tardar ~15-30 segundos)...")
        
        const sssRes = await fetch(`${CORE}/sss?cuil_o_dni=${encodeURIComponent(cuilParaAportes)}`, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const sssData = await sssRes.json()
        
        // Verificar si la web de SSS está caída
        if (!sssData.ok && sssData.error === "WEB_CAIDA") {
          await message.channel.send("⚠️ La web de SSS está caída o no responde. No se pudo obtener información de obra social.")
          obraSocialInfo = null // Forzar a que el resumen muestre SSS **VER**
        } else if (sssData.ok) {
          let mensajeSss = ""
          
          if (sssData.tipo === "traspasos") {
            const cuil = sssData.cuil
            const traspasos = sssData.datos
            
            if (!traspasos || traspasos.length === 0) {
              mensajeSss = `📋 **CUIL: ${cuil}**\n\nℹ️ No se encontraron traspasos registrados`
            } else {
              // Extraer info del ÚLTIMO traspaso para el resumen
              const ultimoTraspaso = traspasos[traspasos.length - 1]
              
              let obraSocialNombre = ""
              let desde = ""
              
              for (const [key, value] of Object.entries(ultimoTraspaso)) {
                const keyLower = key.toLowerCase().trim()
                if (keyLower.includes("obra social") && keyLower.includes("elegida")) {
                  obraSocialNombre = value
                }
                if (keyLower.includes("período desde") || keyLower.includes("periodo desde") || keyLower === "desde") {
                  desde = value
                }
              }
              
              if (obraSocialNombre && desde) {
                const nombreFinal = aplicarAlias(obraSocialNombre)
                
                let fechaFormateada = desde
                const matchFecha = desde.match(/^(\d{2})\/(\d{4})$/)
                if (matchFecha) {
                  const mes = matchFecha[1]
                  const año = matchFecha[2].slice(-2)
                  fechaFormateada = `${mes}/${año}`
                }
                obraSocialInfo = `${nombreFinal} ${fechaFormateada}`
              }
              
              mensajeSss = `📋 **TRASPASOS - CUIL: ${cuil}**\n`
              
              const campoMap = {
                "período desde": "Desde",
                "periodo desde": "Desde",
                "período hasta": "Hasta",
                "periodo hasta": "Hasta",
                "código movimiento": "Movimiento",
                "codigo movimiento": "Movimiento",
                "obra social elegida": "Obra Social Elegida",
                "estado": "Estado"
              }
              
              const camposOmitir = ["código registro", "codigo registro"]
              
              for (let i = 0; i < traspasos.length; i++) {
                mensajeSss += `\n**Traspaso #${i+1}**\n`
                const traspaso = traspasos[i]
                for (const [key, value] of Object.entries(traspaso)) {
                  const keyLower = key.toLowerCase().trim()
                  if (camposOmitir.includes(keyLower)) continue
                  const keyDisplay = campoMap[keyLower] || key
                  mensajeSss += `• ${keyDisplay}: ${value}\n`
                }
              }
              
              mensajeSss = mensajeSss.trimEnd()
            }
          } else if (sssData.tipo === "padron") {
            const cuil = sssData.cuil
            const obraSocial = sssData.obra_social || "No disponible"
            const fechaAlta = sssData.fecha_alta || "No disponible"
            
            if (obraSocial !== "No disponible" && fechaAlta !== "No disponible") {
              // Aplicar alias SIEMPRE
              const nombreFinal = aplicarAlias(obraSocial)
              
              // Intentar extraer año si el formato coincide
              const match = fechaAlta.match(/(\d{2})-(\d{2})-(\d{4})/)
              if (match) {
                const año = match[3]
                obraSocialInfo = `${nombreFinal} ${año}`
              } else {
                // Si no coincide el formato, usar fecha completa
                obraSocialInfo = `${nombreFinal} ${fechaAlta}`
              }
            }
            
            if (obraSocial === "No disponible" && fechaAlta === "No disponible") {
              mensajeSss = `⚠️ No se reportan datos para el CUIL: ${cuil}`
            } else {
              mensajeSss = `📋 **PADRÓN DE BENEFICIARIOS**\n\n**CUIL:** ${cuil}\n**Obra Social:** ${obraSocial}\n**Fecha de Alta:** ${fechaAlta}`
            }
          } else {
            mensajeSss = "❌ Tipo de resultado desconocido"
          }
          
          const sssChunks = dividirMensaje(mensajeSss)
          for (const chunk of sssChunks) {
            await message.channel.send(chunk)
          }
        } else if (!sssData.ok && sssData.error !== "WEB_CAIDA") {
          // Solo mostrar error genérico si NO es WEB_CAIDA (ya se avisó arriba)
          await message.channel.send(`⚠️ SSS: No se encontraron datos ni en traspasos ni en padrón`)
        }
        
        // ═════════════════════════════════════════════════════════════
        // PASO 5: GENERAR RESUMEN FINAL
        // ═════════════════════════════════════════════════════════════
        
        let resumenFinal = ""
        
        // Línea 1: APORTES (siempre se muestra cuando se llega a SSS)
        if (tieneAportesValidos) {
          resumenFinal += "APORTES OK\n"
        } else {
          resumenFinal += "APORTES **VER**\n"
        }
        
        // Línea 2: OBRA SOCIAL
        if (obraSocialInfo) {
          resumenFinal += obraSocialInfo
        } else {
          resumenFinal += "SSS **VER**"
        }
        
        // Enviar resumen (siempre hay contenido si llegamos hasta SSS)
        await message.channel.send(`━━━━━━━━━━━━━━━━━━━━\n📊 **RESUMEN**\n\n${resumenFinal}`)
      } else {
        await message.channel.send(`⚠️ No se pudo obtener un CUIL válido`)
      }
      
      await message.channel.send("✅ Búsqueda completa finalizada")
      
    } catch (e) {
      await message.reply(`❌ Error en el proceso: ${e.message}`)
    }
    return
  }

  // ═══════════════════════════════════════════════════════════════
  // COMANDO:  CALIMONO / MONOCALI
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'calimono' || low === 'monocali') {
    if (!arg) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  calimono <DNI|CUIL> [NOMBRE]\n  monocali <DNI|CUIL> [NOMBRE]\n\n💡 Ejemplos:\n  calimono 47156273 agustin\n  calimono 20471562733 agustin\n  calimono agustin 47156273\n  calimono 47156273`)
      return
    }
    
    let dni = ""
    let nombre = ""
    
    // Parsear DNI y nombre (pueden venir en cualquier orden)
    const parts = arg.split(/\s+/)
    
    for (const part of parts) {
      const cleaned = part.replace(/\-/g, "")
      if (cleaned.match(/^\d{7,11}$/)) {
        dni = cleaned
      } else {
        nombre += (nombre ? " " : "") + part
      }
    }
    
    if (!dni) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  calimono <DNI> [NOMBRE]\n\n💡 Ejemplos:\n  calimono 47156273 agustin\n  calimono agustin 47156273\n  calimono 47156273`)
      return
    }
    
    // Validar que sea DNI (8 dígitos) o CUIL (11 dígitos)
    if (dni.length !== 8 && dni.length !== 11) {
      await message.reply(`❌ **Formato inválido**\n\n📝 Debe ingresar:\n  • DNI de 8 dígitos, o\n  • CUIL de 11 dígitos (con o sin guiones)\n\n💡 Ejemplos:\n  calimono 47156273\n  calimono 20471562735\n  calimono 20-47156273-5\n\n⚠️ Ingresaste ${dni.length} dígitos`)
      return
    }
    
    await message.reply(`🔍 Iniciando verificación unificada de monotributista para DNI/CUIL ${dni}${nombre ? ' con nombre "' + nombre + '"' : ' (sin nombre)'}...`)
    
    // Declarar fecha actual al inicio para uso en todo el flujo (especialmente en MONOTRAS)
    const ahora = new Date()
    
    try {
      // ═════════════════════════════════════════════════════════════
      // PASO 1: OBTENER CUIL Y NOMBRE (igual que CALI)
      // ═════════════════════════════════════════════════════════════
      
      let cuilParaMonopago = null
      let nombreEncontrado = null
      let metodoUsado = null
      
      // Intentar con método primario (ahora optimizado para CUIL de 11 dígitos)
      await message.channel.send(`1️⃣ Buscando con ${CALI_METODO_PRIMARIO}...`)
      
      try {
        const url1 = `${CORE}/${CALI_METODO_PRIMARIO}?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
        const res1 = await fetch(url1, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const data1 = await res1.json()
        
        if (data1.ok && data1.nombre === "ERROR") {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO}: ${data1.cuil}`)
        } else if (data1.ok && data1.cuil === "NO IDENTIFICADO") {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no encontró información`)
        } else if (data1.ok && data1.cuil) {
          if (data1.nombre === "NO_MATCH") {
            const cuilMatch = data1.cuil.match(/CUIL:\s*(\d{11})/i)
            if (cuilMatch) {
              cuilParaMonopago = cuilMatch[1]
              const nombreMatch = data1.cuil.match(/NOMBRE:\s*(.+?)(?:\n|$)/i)
              nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
              metodoUsado = CALI_METODO_PRIMARIO
              await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaMonopago}\n👤 Nombre registrado: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
            } else {
              await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
            }
          } else {
            cuilParaMonopago = data1.cuil.replace(/\-/g, '').replace(/\s/g, '')
            nombreEncontrado = data1.nombre
            metodoUsado = CALI_METODO_PRIMARIO
            console.log(`[CALIMONO DEBUG] Método ${CALI_METODO_PRIMARIO} - CUIL original: "${data1.cuil}" → Limpio: "${cuilParaMonopago}" (${cuilParaMonopago.length} dígitos)`)
            await message.channel.send(`✅ Encontrado con ${CALI_METODO_PRIMARIO}\n📋 CUIL: ${data1.cuil}\n👤 Nombre: ${data1.nombre}`)
          }
        } else {
          await message.channel.send(`⚠️ ${CALI_METODO_PRIMARIO} no pudo obtener datos`)
        }
      } catch (e1) {
        await message.channel.send(`⚠️ Error en ${CALI_METODO_PRIMARIO}: ${e1.message}`)
      }
      
      // Si el método primario falló, intentar con el secundario
      if (!cuilParaMonopago) {
        await message.channel.send(`🔄 Intentando con método alternativo: ${CALI_METODO_SECUNDARIO}...`)
        
        try {
          const url2 = `${CORE}/${CALI_METODO_SECUNDARIO}?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
          const res2 = await fetch(url2, {
            headers: { 'X-CALI-Flow': 'true' }
          })
          const data2 = await res2.json()
          
          if (data2.ok && data2.nombre === "ERROR") {
            await message.channel.send(`❌ ${CALI_METODO_SECUNDARIO}: ${data2.cuil}`)
          } else if (data2.ok && data2.cuil === "NO IDENTIFICADO") {
            await message.channel.send(`❌ ${CALI_METODO_SECUNDARIO} no encontró información`)
          } else if (data2.ok && data2.cuil) {
            if (data2.nombre === "NO_MATCH") {
              const cuilMatch = data2.cuil.match(/CUIL:\s*(\d{11})/i)
              if (cuilMatch) {
                cuilParaMonopago = cuilMatch[1]
                const nombreMatch = data2.cuil.match(/NOMBRE:\s*(.+?)(?:\n|$)/i)
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = CALI_METODO_SECUNDARIO
                await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaMonopago}\n👤 Nombre registrado: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`⚠️ ${CALI_METODO_SECUNDARIO} tampoco encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
              }
            } else {
              cuilParaMonopago = data2.cuil.replace(/\-/g, '').replace(/\s/g, '')
              nombreEncontrado = data2.nombre
              metodoUsado = CALI_METODO_SECUNDARIO
              console.log(`[CALIMONO DEBUG] Método ${CALI_METODO_SECUNDARIO} - CUIL original: "${data2.cuil}" → Limpio: "${cuilParaMonopago}" (${cuilParaMonopago.length} dígitos)`)
              await message.channel.send(`✅ Encontrado con ${CALI_METODO_SECUNDARIO}\n📋 CUIL: ${data2.cuil}\n👤 Nombre: ${data2.nombre}`)
            }
          } else {
            await message.channel.send(`⚠️ ${CALI_METODO_SECUNDARIO} tampoco pudo obtener datos`)
          }
        } catch (e2) {
          await message.channel.send(`⚠️ Error en ${CALI_METODO_SECUNDARIO}: ${e2.message}`)
        }
      }
      
      // Si ambos métodos fallaron, intentar con nosis como último recurso
      if (!cuilParaMonopago) {
        // nosis.py solo acepta DNI de 7-9 dígitos, no acepta CUIL (11 dígitos)
        if (dni.length === 11) {
          // Es CUIL - nosis no puede procesar CUILs directamente
          await message.channel.send(`❌ No se pudo obtener información. Nosis.com no puede procesar CUILs directamente`)
        } else {
          await message.channel.send(`🔄 Último intento: Chequeando en Nosis.com...`)
          
          try {
            const url3 = `${CORE}/nosis?dni=${encodeURIComponent(dni)}${nombre ? '&nombre=' + encodeURIComponent(nombre) : ''}`
            const res3 = await fetch(url3, {
              headers: { 'X-CALI-Flow': 'true' }
            })
            const data3 = await res3.json()
          
          if (data3.ok && data3.cuil && !data3.cuil.includes('@cuit@')) {
            if (data3.nombre === "FILTERED_SINGLE") {
              const cuilMatch = data3.cuil.match(/CUIL:\s*(\d{2}-\d{8}-\d{1})/i)
              const nombreMatch = data3.cuil.match(/NOMBRE:\s*(.+?)(?=\n|$)/i)
              if (cuilMatch) {
                cuilParaMonopago = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                await message.channel.send(`✅ Encontrado con Nosis.com\n📋 CUIL: ${cuilParaMonopago}\n👤 Nombre: ${nombreEncontrado}`)
              } else {
                await message.channel.send(`❌ Error procesando resultado de Nosis.com`)
              }
            } else if (data3.nombre === "FILTERED_MULTIPLE") {
              const cuilMatch = data3.cuil.match(/CUIL\s+1:\s*(\d{2}-\d{8}-\d{1})/i)
              const nombreMatch = data3.cuil.match(/NOMBRE\s+1:\s*(.+?)(?=\n|$)/i)
              if (cuilMatch) {
                cuilParaMonopago = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                await message.channel.send(`⚠️ Se encontraron múltiples coincidencias. Usando la primera:\n\n📋 CUIL: ${cuilParaMonopago}\n👤 Nombre: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`❌ Error procesando resultados múltiples de Nosis.com`)
              }
            } else if (data3.nombre === "NO_MATCH_SHOWING_ALL") {
              const cuilMatch = data3.cuil.match(/CUIL\s+\d+:\s*(\d{2}-\d{8}-\d{1})/i)
              if (cuilMatch) {
                cuilParaMonopago = cuilMatch[1].replace(/\-/g, '').replace(/\s/g, '')
                const nombreMatch = data3.cuil.match(/NOMBRE\s+\d+:\s*(.+?)(?=\n|$)/i)
                nombreEncontrado = nombreMatch ? nombreMatch[1].trim() : "NO IDENTIFICADO"
                metodoUsado = 'nosis'
                await message.channel.send(`⚠️ ADVERTENCIA: ${nombre ? 'El nombre proporcionado "' + nombre + '" no coincide exactamente con el registrado en la base de datos' : 'Búsqueda sin nombre proporcionado'}.\n\n📋 CUIL encontrado: ${cuilParaMonopago}\n👤 Nombre registrado: ${nombreEncontrado}\n\n▶️ Continuando con el flujo de verificación...`)
              } else {
                await message.channel.send(`❌ Nosis.com no encontró coincidencia${nombre ? ' con "' + nombre + '"' : ''}`)
              }
            } else {
              cuilParaMonopago = data3.cuil.replace(/\-/g, '').replace(/\s/g, '')
              nombreEncontrado = data3.nombre
              metodoUsado = 'nosis'
              console.log(`[CALIMONO DEBUG] Método nosis - CUIL original: "${data3.cuil}" → Limpio: "${cuilParaMonopago}" (${cuilParaMonopago.length} dígitos)`)
              await message.channel.send(`✅ Encontrado con Nosis.com\n📋 CUIL: ${data3.cuil}\n👤 Nombre: ${data3.nombre}`)
            }
          } else {
            await message.channel.send(`❌ Nosis.com tampoco pudo obtener datos`)
          }
          } catch (e3) {
            await message.channel.send(`⚠️ Error en Nosis: ${e3.message}`)
          }
        }
      }
      
      // Si ningún método funcionó, detener el proceso
      if (!cuilParaMonopago) {
        await message.channel.send(`❌ Todos los métodos fallaron. No se pudo obtener información.`)
        await message.channel.send(`💡 Verifica que el DNI y nombre sean correctos e intenta nuevamente.`)
        return
      }
      
      // VALIDACIÓN: Verificar que el CUIL tenga 11 dígitos
      console.log(`[CALIMONO DEBUG] CUIL obtenido: "${cuilParaMonopago}" (${cuilParaMonopago.length} dígitos)`)
      if (cuilParaMonopago.length !== 11) {
        await message.channel.send(`⚠️ **Error interno**: CUIL con longitud inválida (${cuilParaMonopago.length} dígitos en lugar de 11)`)
        await message.channel.send(`📊 CUIL recibido: \`${cuilParaMonopago}\``)
        await message.channel.send(`💡 Por favor reporta este error indicando el DNI/CUIL que usaste. El bot continuará pero puede fallar.`)
        // No retornar, continuar para ver el error completo
      }
      
      // ═════════════════════════════════════════════════════════════
      // PASO 2: CONSULTA MONOPAGO
      // ═════════════════════════════════════════════════════════════
      
      // Declarar variable de estado de aportes (se definirá después de consultar mono_pagos)
      let estadoAportes = ""
      
      await message.channel.send("2️⃣ Consultando MONOPAGO (esto puede tardar ~15-30 segundos)...")
      
      console.log(`[CALIMONO DEBUG] Enviando a /mono_pagos: CUIL="${cuilParaMonopago}"`)
      const monopagoRes = await fetch(`${CORE}/mono_pagos`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CALI-Flow': 'true' 
        },
        body: JSON.stringify({ cuil: cuilParaMonopago })
      })
      const monopagoData = await monopagoRes.json()
      console.log(`[CALIMONO DEBUG] Respuesta /mono_pagos:`, monopagoData.ok ? '✅ OK' : `❌ ERROR: ${monopagoData.error}`)
      
      if (!monopagoData.ok) {
        // Verificar si es error de captcha agotado
        if (monopagoData.error && monopagoData.error.includes("No se pudo resolver el captcha")) {
          await message.channel.send(`⚠️ **Error interno**: El sistema de verificación de seguridad falló después de 3 intentos.`)
          await message.channel.send(`🔄 Por favor intenta nuevamente en unos momentos.`)
          return
        }
        
        // Si no hay datos reales en monopago, continuar para consultar monotras
        await message.channel.send(`⚠️ No se encontraron datos de aportes en MONOPAGO`)
        estadoAportes = "SIN_APORTES"
      } else {
        // ═════════════════════════════════════════════════════════════
        // PASO 3: ANÁLISIS DE PERÍODOS DE MONOPAGO (solo si hay datos)
        // ═════════════════════════════════════════════════════════════
        
        const periodos = monopagoData.periodos || []
        
        // Eliminar duplicados
        const periodosUnicos = [...new Set(periodos)]
        
        // Formatear períodos con bullets
        let periodosTexto = "📊 MONOPAGO: " + monopagoData.nombre + "\n📅 Períodos encontrados:"
        for (const periodo of periodosUnicos) {
          periodosTexto += `\n+ ${periodo}`
        }
        await message.channel.send(periodosTexto)
        
        // Calcular estado de aportes usando ahora declarada globalmente
        const añoActual = ahora.getFullYear()
        const mesActual = ahora.getMonth() + 1 // 0-based
        
        // Ordenar períodos de más reciente a más antiguo
        const periodosOrdenados = periodosUnicos.sort((a, b) => parseInt(b) - parseInt(a))
        
        // Determinar estado de APORTES
        if (periodosOrdenados.length === 0) {
          estadoAportes = "SIN_APORTES"
          console.log(`[CALIMONO DEBUG] Sin aportes en MONOPAGO`)
        } else {
          // Verificar período más reciente
          const periodoMasReciente = parseInt(periodosOrdenados[0])
          const añoPeriodoReciente = Math.floor(periodoMasReciente / 100)
          const mesPeriodoReciente = periodoMasReciente % 100
          
          const diferenciaMesesReciente = (añoActual - añoPeriodoReciente) * 12 + (mesActual - mesPeriodoReciente)
          
          console.log(`[CALIMONO DEBUG] Período más reciente: ${periodoMasReciente}, diferencia: ${diferenciaMesesReciente} meses`)
          
          if (diferenciaMesesReciente > 2) {
            // Aporte más reciente muy atrasado (>2 meses)
            estadoAportes = "APORTE_ATRASADO"
            console.log(`[CALIMONO DEBUG] Aporte más reciente atrasado: ${diferenciaMesesReciente} meses`)
          } else {
            // Aporte reciente OK, contar consecutivos
            let mesesConsecutivos = 1
            for (let i = 1; i < periodosOrdenados.length; i++) {
              const periodoActual = parseInt(periodosOrdenados[i])
              const periodoAnterior = parseInt(periodosOrdenados[i - 1])
              
              const añoActual = Math.floor(periodoActual / 100)
              const mesActual = periodoActual % 100
              const añoAnterior = Math.floor(periodoAnterior / 100)
              const mesAnterior = periodoAnterior % 100
              
              const diferenciaMeses = (añoAnterior - añoActual) * 12 + (mesAnterior - mesActual)
              
              if (diferenciaMeses === 1) {
                mesesConsecutivos++
              } else {
                break
              }
            }
            
            console.log(`[CALIMONO DEBUG] Meses consecutivos desde más reciente: ${mesesConsecutivos}`)
            
            if (mesesConsecutivos >= 3) {
              estadoAportes = "APORTES_OK"
            } else {
              estadoAportes = "APORTES_PENDIENTES"
            }
          }
        }
      }
      
      // ═════════════════════════════════════════════════════════════
      // PASO 4: CONSULTA MONOTRAS (SIEMPRE SE EJECUTA)
      // ═════════════════════════════════════════════════════════════
      
      await message.channel.send("3️⃣ Consultando MONOTRAS...")
      
      const monotrasRes = await fetch(`${CORE}/monotras`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CALI-Flow': 'true' 
        },
        body: JSON.stringify({ cuil: cuilParaMonopago })
      })
      const monotrasData = await monotrasRes.json()
      
      // Inicializar variables de MONOTRAS
      let rechazoMonotras = null
      let obraSocialNombre = ""
      let obraSocialFecha = ""
      let resultadoMonotras = null
      let evolucion = []
      let monotrasDisponible = false
      
      if (!monotrasData.ok) {
        await message.channel.send(`⚠️ MONOTRAS: ${monotrasData.error || 'No se encontraron datos'}`)
        // NO hacer return - continuar al resumen con estado de aportes
        monotrasDisponible = false
      } else {
        monotrasDisponible = true
        
        // ═════════════════════════════════════════════════════════════
        // VALIDACIÓN: MONOTRIBUTO SOCIAL
        // ═════════════════════════════════════════════════════════════
        
        const situacion = (monotrasData.situacion || "").toUpperCase()
        const categoria = (monotrasData.categoria || "").toUpperCase()
        
        // Buscar "SOCIAL" en situación O en categoría
        if (situacion.includes("SOCIAL") || categoria.includes("MONOTRIBUTO SOCIAL")) {
          rechazoMonotras = "MONOTRIBUTO_SOCIAL"
        }
        
        // ═════════════════════════════════════════════════════════════
        // PASO 5: ANÁLISIS DE EVOLUCIÓN MONOTRAS
        // ═════════════════════════════════════════════════════════════
        
        evolucion = monotrasData.evolucion || []
        
        // ═════════════════════════════════════════════════════════════
        // VALIDACIÓN: OBRA SOCIAL DE PRENSA (IGUALDAD)
        // ═════════════════════════════════════════════════════════════
        
        if (evolucion.length > 0 && !rechazoMonotras) {
          const ultimaObraSocial = evolucion[evolucion.length - 1].obra_social || ""
          if (ultimaObraSocial.toUpperCase().includes("OBRA SOCIAL DE TRABAJADORES DE PRENSA DE BUENOS AIRES")) {
            rechazoMonotras = "YA_TIENE_IGUALDAD"
          }
        }
        
        // ═════════════════════════════════════════════════════════════
        // ANÁLISIS DE TRASPASO Y EVOLUCIÓN
        // ═════════════════════════════════════════════════════════════
        
        if (evolucion.length === 0) {
          // Sin registros de evolución
          resultadoMonotras = null
        } else if (evolucion.length === 1) {
          // Solo 1 registro - CALIFICA PERFECTO siempre
          const ultimo = evolucion[0]
          obraSocialNombre = ultimo.obra_social
          obraSocialFecha = ultimo.periodo_inicio
          resultadoMonotras = "CALIFICA_PERFECTO"
        } else {
          // Hay 2+ registros en evolución
          const penultimo = evolucion[evolucion.length - 2]
          const ultimo = evolucion[evolucion.length - 1]
          
          obraSocialNombre = ultimo.obra_social
          obraSocialFecha = ultimo.periodo_inicio
          
          // Función para parsear período "MM/YYYY" a objeto Date
          function parsearPeriodo(periodo) {
            if (periodo === "/" || !periodo) return null
            const match = periodo.match(/^(\d{2})\/(\d{4})$/)
            if (!match) return null
            const mes = parseInt(match[1])
            const año = parseInt(match[2])
            return new Date(año, mes - 1, 1) // mes-1 porque Date usa 0-based
          }
          
          const periodoFinPenultimo = parsearPeriodo(penultimo.periodo_fin)
          const periodoIniciUltimo = parsearPeriodo(ultimo.periodo_inicio)
          
          // CASO A: Hay 1 o más meses vacíos entre traspasos → ADHESIÓN
          let hayMesVacio = false
          if (periodoFinPenultimo && periodoIniciUltimo) {
            // Calcular diferencia en meses
            const diferenciaMeses = (periodoIniciUltimo.getFullYear() - periodoFinPenultimo.getFullYear()) * 12 
                                   + (periodoIniciUltimo.getMonth() - periodoFinPenultimo.getMonth()) - 1
            
            if (diferenciaMeses >= 1) {
              hayMesVacio = true
            }
          }
          
          if (hayMesVacio) {
            // CASO A: ADHESIÓN (hay al menos 1 mes vacío entre traspasos)
            resultadoMonotras = "ADHESION"
          } else if (ultimo.periodo_fin === "/") {
            // CASO B: Último registro tiene periodo_fin = "/" (activo)
            const periodoInicioUltimo = parsearPeriodo(ultimo.periodo_inicio)
            
            if (periodoInicioUltimo) {
              // Calcular meses desde el periodo_inicio hasta ahora
              const mesesDesdeInicio = (ahora.getFullYear() - periodoInicioUltimo.getFullYear()) * 12 
                                      + (ahora.getMonth() - periodoInicioUltimo.getMonth())
              
              const mesesFaltantesParaAño = Math.max(0, 12 - mesesDesdeInicio)
              
              if (mesesFaltantesParaAño === 0) {
                // Ya pasó 1 año o más
                resultadoMonotras = "CALIFICA_PERFECTO"
              } else if (mesesFaltantesParaAño >= 1 && mesesFaltantesParaAño <= 3) {
                // Faltan 1-3 meses para cumplir 1 año
                resultadoMonotras = "PENDIENTE_CALIFICA"
              } else if (!rechazoMonotras) {
                // Faltan 4+ meses - TRASPASO RECIENTE (solo si no hay otro rechazo)
                rechazoMonotras = "TRASPASO_RECIENTE"
              }
            }
          } else {
            // CASO C: Último registro tiene periodo_fin con fecha (finalizó)
            // Si ya finalizó, significa que completó el período → CALIFICA PERFECTO
            resultadoMonotras = "CALIFICA_PERFECTO"
          }
        }
      } // Fin del bloque else (monotrasDisponible = true)
      
      
      // ═════════════════════════════════════════════════════════════
      // GENERAR Y ENVIAR RESUMEN FINAL CON PRIORIDADES
      // ═════════════════════════════════════════════════════════════
      
      // Mostrar MONOTRAS completo solo si hay datos disponibles
      if (monotrasDisponible) {
        let textoMonotras = `✅ MONOTRIBUTISTA SSS\n\n`
        textoMonotras += `👤 ${monotrasData.nombre}\n`
        textoMonotras += `📊 Situación: ${monotrasData.situacion}\n`
        textoMonotras += `📋 Categoría: ${monotrasData.categoria}\n\n`
        
        if (evolucion.length > 0) {
          textoMonotras += `📅 EVOLUCIÓN DEL PADRÓN:\n\n`
          for (let i = 0; i < evolucion.length; i++) {
            const ev = evolucion[i]
            textoMonotras += `• ${ev.periodo_inicio} → ${ev.periodo_fin}\n`
            textoMonotras += `  ${ev.obra_social}\n\n`
          }
        } else {
          textoMonotras += `📅 Sin registros de evolución\n`
        }
        
        const chunksMonotras = dividirMensaje(textoMonotras)
        for (const chunk of chunksMonotras) {
          await message.channel.send(chunk)
        }
      }
      
      // RESUMEN FINAL con lógica de prioridades
      let resumenFinal = ""
      resumenFinal += `━━━━━━━━━━━━━━━━━━━━\n📊 **RESUMEN CALIMONO**\n\n`
      
      // PRIORIDAD 1: Rechazos de MONOTRAS (ganan sobre todo)
      if (rechazoMonotras === "MONOTRIBUTO_SOCIAL") {
        resumenFinal += `❌NO CALIFICA: MONOTRIBUTO SOCIAL❌`
      } else if (rechazoMonotras === "YA_TIENE_IGUALDAD") {
        resumenFinal += `❌NO CALIFICA: YA TIENE IGUALDAD❌`
      } else if (rechazoMonotras === "TRASPASO_RECIENTE") {
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n`
        }
        resumenFinal += `❌NO CALIFICA: TRASPASO RECIENTE❌`
      }
      // PRIORIDAD 2: Resultados positivos de MONOTRAS (si aportes OK)
      else if (resultadoMonotras === "CALIFICA_PERFECTO" && estadoAportes === "APORTES_OK") {
        resumenFinal += `APORTES OK\n`
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n\n`
        }
        resumenFinal += `✅CALIFICA PERFECTO✅`
      } else if (resultadoMonotras === "PENDIENTE_CALIFICA" && estadoAportes === "APORTES_OK") {
        resumenFinal += `APORTES OK\n`
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n\n`
        }
        resumenFinal += `⚠️PENDIENTE - CALIFICA⚠️`
      } else if (resultadoMonotras === "ADHESION" && estadoAportes === "APORTES_OK") {
        resumenFinal += `APORTES OK\n`
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n\n`
        }
        resumenFinal += `✅ADHESION - CALIFICA PERFECTO✅`
      }
      // PRIORIDAD 3: Problemas de APORTES (sin rechazos de monotras)
      else if (estadoAportes === "APORTES_PENDIENTES") {
        resumenFinal += `APORTES OK\n`
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n`
        }
        resumenFinal += `⚠️PENDIENTE: FALTAN APORTES⚠️`
      } else if (estadoAportes === "APORTE_ATRASADO" || estadoAportes === "SIN_APORTES") {
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n`
        }
        resumenFinal += `⚠️RECHAZO: FALTA DE APORTES O POSIBLE ADHESION ⚠️`
      }
      // CASO POR DEFECTO: APORTES OK pero sin análisis completo de monotras
      else if (estadoAportes === "APORTES_OK") {
        if (obraSocialNombre && obraSocialFecha) {
          const obraSocialConAlias = aplicarAlias(obraSocialNombre)
          resumenFinal += `${obraSocialConAlias} ${obraSocialFecha}\n`
        }
        resumenFinal += `✅APORTES OK✅`
      }
      
      await message.channel.send(resumenFinal)
      
    } catch (e) {
      await message.reply(`❌ Error en el proceso: ${e.message}`)
    }
    return
  }

////////////////////////////////
//CHEQUEO MASIVO DE APORTES
////////////////////////////////  

  // ═══════════════════════════════════════════════════════════════
  // COMANDO:  DESEMPLEADO (Verificación masiva de aportes)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'desempleado') {
    // Parsear CUILs del mensaje (pueden venir en múltiples líneas o separados por espacios)
    const cuilsRaw = arg.split(/[\s\n]+/).filter(c => c.match(/^\d{10,11}$/))
    
    // Validar que haya CUILs
    if (cuilsRaw.length === 0) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  DESEMPLEADO\n  CUIL1\n  CUIL2\n  CUIL3\n  .. .\n\n💡 Ejemplo:\n  DESEMPLEADO\n  20471562733\n  27301234567\n  23456789012\n\n⚠️ Máximo 80 CUILs por comando`)
      return
    }
    
    // Validar máximo 100 CUILs
    if (cuilsRaw.length > 100) {
      await message.reply(`❌ **Demasiados CUILs**\n\nMáximo permitido:  80 CUILs\nProporcionados: ${cuilsRaw.length}\n\n💡 Divide la consulta en varios comandos`)
      return
    }
    
    const totalCuils = cuilsRaw.length
    await message.reply(`🔍 Iniciando verificación de ${totalCuils} CUIL(s)...`)
    
    // Contadores
    let cuilsConAportes = 0
    let cuilsCodem = 0
    let cuilsNo = 0
    let cuilsConError = 0
    
    // Listas para el resumen final
    let listaCuilsAportes = []
    let listaCuilsCodem = []
    let listaCuilsNo = []
    
    // Lista ordenada con resultados (para formato Google Sheets)
    let resultadosOrdenados = []
    
    for (let i = 0; i < cuilsRaw.length; i++) {
      const cuil = cuilsRaw[i]
      const progreso = `(${i + 1}/${totalCuils})`
      
      // Enviar mensaje de progreso
      const statusMsg = await message.channel.send(`🔄 Chequeando ${cuil} ${progreso}...`)
      
      try {
        const arcaRes = await fetch(`${CORE}/arca?cuil=${encodeURIComponent(cuil)}`, {
          headers: { 'X-CALI-Flow': 'true' }
        })
        const arcaData = await arcaRes.json()
        
        // Verificar si es error de "no tiene aportes" -> verificar CODEM
        if (!arcaData.ok && arcaData.error && arcaData.error.includes("no tiene aportes")) {
          await statusMsg.edit(`🔍 ${cuil} ${progreso} - Posible CODEM, verificando...`)
          
          // Consultar CODEM
          try {
            const codemRes = await fetch(`${CORE}/codem?doc=${encodeURIComponent(cuil)}`, {
              headers: { 'X-CALI-Flow': 'true' }
            })
            const codemData = await codemRes.text()
            
            // Verificar si hay rechazo en CODEM
            const esPasivo = /Situación:\s*PASIVO/i.test(codemData)
            const esMonotributista = /Situación:\s*MONOTRIBUTISTA/i.test(codemData)
            const esFamiliar = /Condición:\s*Familiar/i.test(codemData)
            const sinResultados = /La consulta no arrojó resultados\./i.test(codemData)
            
            if (esPasivo || esMonotributista || esFamiliar || sinResultados) {
              // Rechazo en CODEM
              await statusMsg.edit(`❌ ${cuil} ${progreso} - NO (CODEM rechazado)`)
              cuilsNo++
              listaCuilsNo.push(cuil)
              resultadosOrdenados.push({cuil, resultado: 'NO'})
            } else {
              // CODEM califica
              await statusMsg.edit(`✅ ${cuil} ${progreso} - CODEM califica`)
              cuilsCodem++
              listaCuilsCodem.push(cuil)
              resultadosOrdenados.push({cuil, resultado: 'CODEM'})
            }
          } catch (codemError) {
            await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error verificando CODEM`)
            cuilsConError++
          }
          continue
        }
        
        // Otros errores de ARCA
        if (!arcaData.ok) {
          await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error: ${arcaData.error || 'Sin datos'}`)
          cuilsConError++
          continue
        }
        
        // Analizar empleadores
        let hayEmpleadorActivo = false
        let hayEmpleadorEnLicencia = false
        let imagenesEmpleadoresActivos = []
        
        if (arcaData.empleadores_data) {
          for (let empIndex = 0; empIndex < arcaData.empleadores_data.length; empIndex++) {
            const emp = arcaData.empleadores_data[empIndex]
            
            if (emp.rows && emp.rows.length > 0) {
              const ultimaFila = emp.rows[emp.rows.length - 1]
              
              // Obtener valor de columna DDJJ y todos los valores de la fila
              let valorDDJJ = null
              let valoresFila = []
              
              if (Array.isArray(ultimaFila)) {
                valorDDJJ = ultimaFila[1]
                valoresFila = ultimaFila
              } else if (typeof ultimaFila === 'object') {
                valorDDJJ = ultimaFila.ddjj || ultimaFila.DDJJ || ultimaFila['ddjj']
                valoresFila = Object.values(ultimaFila)
                
                if (!valorDDJJ && valoresFila.length > 1) {
                  valorDDJJ = valoresFila[1]
                }
              }
              
              // Verificar si tiene "SI" en columna DDJJ
              const tieneSI = valorDDJJ && String(valorDDJJ).toUpperCase().trim() === "SI"
              
              if (tieneSI) {
                // Verificar si hay "-" en alguna columna de la última fila
                let tieneGuion = false
                for (const valor of valoresFila) {
                  if (String(valor).trim() === "-") {
                    tieneGuion = true
                    break
                  }
                }
                
                if (tieneGuion) {
                  hayEmpleadorEnLicencia = true
                } else {
                  hayEmpleadorActivo = true
                  // Guardar índice de imagen del empleador activo
                  if (arcaData.images && arcaData.images[empIndex]) {
                    imagenesEmpleadoresActivos.push(arcaData.images[empIndex])
                  }
                }
              }
            }
          }
        }
        
        // Evaluar resultado
        if (hayEmpleadorActivo) {
          // ✅ Tiene aportes válidos
          await statusMsg.edit(`✅ ${cuil} ${progreso} - APORTES`)
          cuilsConAportes++
          listaCuilsAportes.push(cuil)
          resultadosOrdenados.push({cuil, resultado: 'APORTES'})
          
          // Enviar imágenes de empleadores activos
          if (imagenesEmpleadoresActivos.length > 0) {
            for (const img of imagenesEmpleadoresActivos) {
              const buf = Buffer.from(img.png_base64, 'base64')
              const attachment = new AttachmentBuilder(buf, { name:  `aportes_${cuil}.png` })
              await message.channel.send({
                content: img.caption || `Empleador activo - CUIL:  ${cuil}`,
                files: [attachment]
              })
            }
          } else if (arcaData.images && arcaData.images.length > 0) {
            // Si no pudimos mapear, enviar todas las imágenes
            for (const img of arcaData.images) {
              const buf = Buffer.from(img.png_base64, 'base64')
              const attachment = new AttachmentBuilder(buf, { name: `aportes_${cuil}.png` })
              await message.channel.send({
                content: img.caption || `CUIL: ${cuil}`,
                files: [attachment]
              })
            }
          }
          
        } else if (hayEmpleadorEnLicencia) {
          // ⚠️ En licencia - NO califica
          await statusMsg.edit(`❌ ${cuil} ${progreso} - NO (LICENCIA)`)
          cuilsNo++
          listaCuilsNo.push(cuil)
          resultadosOrdenados.push({cuil, resultado: 'NO'})
          
        } else {
          // ❌ Desempleado - NO califica
          await statusMsg.edit(`❌ ${cuil} ${progreso} - NO (DESEMPLEADO)`)
          cuilsNo++
          listaCuilsNo.push(cuil)
          resultadosOrdenados.push({cuil, resultado: 'NO'})
        }
        
      } catch (e) {
        await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error de conexión:  ${e.message}`)
        cuilsConError++
      }
    }
    
    // Resumen final con formato de tabla
    let resumen = `━━━━━━━━━━━━━━━━━━━━\n📊 **RESUMEN VERIFICACIÓN**\n\n`
    resumen += `📋 Total verificados: ${totalCuils}\n`
    resumen += `✅ APORTES: ${cuilsConAportes}\n`
    resumen += `✅ CODEM: ${cuilsCodem}\n`
    resumen += `❌ NO: ${cuilsNo}\n`
    if (cuilsConError > 0) {
      resumen += `🔴 Con errores: ${cuilsConError}\n`
    }
    
    // Lista de resultados en formato tabla
    resumen += `\n━━━━━━━━━━━━━━━━━━━━\n📋 **RESULTADOS**\n\n`
    
    // Agregar CUILs con APORTES
    for (const cuilAprobado of listaCuilsAportes) {
      resumen += `${cuilAprobado}\tAPORTES\n`
    }
    
    // Agregar CUILs con CODEM
    for (const cuilCodem of listaCuilsCodem) {
      resumen += `${cuilCodem}\tCODEM\n`
    }
    
    // Agregar CUILs NO
    for (const cuilNo of listaCuilsNo) {
      resumen += `${cuilNo}\tNO\n`
    }
    
    // Dividir mensaje si es muy largo
    const chunks = dividirMensaje(resumen)
    for (const chunk of chunks) {
      await message.channel.send(chunk)
    }
    
    // Mensaje adicional: formato para Google Sheets (orden de verificación)
    let mensajeGoogleSheets = `━━━━━━━━━━━━━━━━━━━━\n📋 **FORMATO PARA COPIAR A GOOGLE SHEETS**\n\`\`\`\n`
    for (const item of resultadosOrdenados) {
      mensajeGoogleSheets += `${item.cuil}\t${item.resultado}\n`
    }
    mensajeGoogleSheets += `\`\`\``
    
    const chunksSheets = dividirMensaje(mensajeGoogleSheets)
    for (const chunk of chunksSheets) {
      await message.channel.send(chunk)
    }
    
    // Mensaje con la fórmula necesaria
    await message.channel.send(`**FÓRMULA NECESARIA:**\n\`\`\`\n=ARRAYFORMULA(IF(A:A=""; ""; SPLIT(A:A; " ")))\n\`\`\``)
    
    return
  }

  // ═══════════════════════════════════════════════════════════════
  // COMANDO: NUEVOMONO (Verificación masiva de monotributistas)
  // ═══════════════════════════════════════════════════════════════
  
  if (low === 'nuevomono') {
    // Parsear CUILs del mensaje (pueden venir en múltiples líneas o separados por espacios)
    const cuilsRaw = arg.split(/[\s\n]+/).filter(c => c.match(/^\d{10,11}$/))
    
    // Validar que haya CUILs
    if (cuilsRaw.length === 0) {
      await message.reply(`❌ **Uso incorrecto**\n\n📝 Formato:\n  NUEVOMONO\n  CUIL1\n  CUIL2\n  CUIL3\n  ...\n\n💡 Ejemplo:\n  NUEVOMONO\n  20471562733\n  27301234567\n  23456789012\n\n⚠️ Máximo 170 CUILs por comando`)
      return
    }
    
    // Validar máximo 170 CUILs
    if (cuilsRaw.length > 170) {
      await message.reply(`❌ **Demasiados CUILs**\n\nMáximo permitido: 170 CUILs\nProporcionados: ${cuilsRaw.length}\n\n💡 Divide la consulta en varios comandos`)
      return
    }
    
    const totalCuils = cuilsRaw.length
    
    // CONFIGURACIÓN DE RATE LIMIT
    // El servidor permite 10 consultas por minuto
    // Para estar seguros, usamos 9 consultas por minuto = 1 consulta cada 6.7 segundos
    const PAUSA_MS = 7000 // 7 segundos entre consultas (safe margin)
    const tiempoEstimadoMinutos = Math.ceil((totalCuils * PAUSA_MS) / 60000)
    
    await message.reply(`🔍 Iniciando verificación de ${totalCuils} monotributista(s)...\n⏱️ Tiempo estimado: ~${tiempoEstimadoMinutos} minuto(s)\n⚙️ Velocidad: ~9 consultas/minuto (límite de API)`)
    
    // Contadores
    let cuilsActivos = 0
    let cuilsNoActivos = 0
    let cuilsConError = 0
    
    // Listas para el resumen final
    let listaCuilsActivos = []
    let listaCuilsNoActivos = []
    
    // Lista ordenada con resultados (para formato Google Sheets)
    let resultadosOrdenados = []
    
    for (let i = 0; i < cuilsRaw.length; i++) {
      const cuil = cuilsRaw[i]
      const progreso = `(${i + 1}/${totalCuils})`
      
      // Enviar mensaje de progreso
      const statusMsg = await message.channel.send(`🔄 Verificando monotributista ${cuil} ${progreso}...`)
      
      try {
        const monotrasRes = await fetch(`${CORE}/monotras`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'X-CALI-Flow': 'true' 
          },
          body: JSON.stringify({ cuil: cuil })
        })
        const monotrasData = await monotrasRes.json()
        
        // Verificar si es error de rate limit
        if (!monotrasData.ok && monotrasData.error && monotrasData.error.includes("Rate limit exceeded")) {
          await statusMsg.edit(`⏸️ ${cuil} ${progreso} - Rate limit detectado, esperando 60 segundos...`)
          // Esperar 60 segundos para resetear el contador del servidor
          await new Promise(resolve => setTimeout(resolve, 60000))
          
          // Reintentar la consulta
          await statusMsg.edit(`🔄 Reintentando ${cuil} ${progreso}...`)
          const retryRes = await fetch(`${CORE}/monotras`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'X-CALI-Flow': 'true' 
            },
            body: JSON.stringify({ cuil: cuil })
          })
          const retryData = await retryRes.json()
          
          if (!retryData.ok) {
            await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error tras reintento: ${retryData.error || 'Sin datos'}`)
            cuilsConError++
            // NO hacer continue aquí - ir a la pausa al final
          } else {
            // Usar datos del reintento
            monotrasData.ok = retryData.ok
            monotrasData.situacion = retryData.situacion
            monotrasData.categoria = retryData.categoria
          }
        } else if (!monotrasData.ok) {
          // Error en la consulta (no rate limit)
          await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error: ${monotrasData.error || 'Sin datos'}`)
          cuilsConError++
          // NO hacer continue aquí - ir a la pausa al final
        }
        
        // Solo procesar si la consulta fue exitosa
        if (monotrasData.ok) {
          // Obtener situación y normalizar
          const situacion = (monotrasData.situacion || "").toUpperCase().trim()
          
          console.log(`[NUEVOMONO] CUIL ${cuil}: situacion="${situacion}"`)
          
          // Verificar si la situación es "ACTIVO"
          if (situacion === "ACTIVO" || situacion === "ACTIVA") {
            // ✅ ACTIVO - Califica
            const categoria = monotrasData.categoria || "S/D"
            await statusMsg.edit(`✅ ${cuil} ${progreso} - ACTIVO (${categoria})`)
            cuilsActivos++
            listaCuilsActivos.push(cuil)
            resultadosOrdenados.push({cuil, resultado: 'ACTIVO', categoria})
          } else {
            // ❌ NO ACTIVO - No califica
            await statusMsg.edit(`❌ ${cuil} ${progreso} - NO ACTIVO (${situacion || 'Sin situación'})`)
            cuilsNoActivos++
            listaCuilsNoActivos.push(cuil)
            resultadosOrdenados.push({cuil, resultado: 'NO', situacion: situacion || 'Sin situación'})
          }
        }
        
      } catch (e) {
        await statusMsg.edit(`⚠️ ${cuil} ${progreso} - Error de conexión: ${e.message}`)
        cuilsConError++
        // NO hacer continue aquí - ir a la pausa al final
      }
      
      // PAUSA OBLIGATORIA - Se ejecuta SIEMPRE, sin importar el resultado
      if (i < cuilsRaw.length - 1) {
        // Mostrar cuenta regresiva cada 10 consultas
        if ((i + 1) % 10 === 0) {
          const restantes = totalCuils - (i + 1)
          const tiempoRestanteMin = Math.ceil((restantes * PAUSA_MS) / 60000)
          await message.channel.send(`⏳ Progreso: ${i + 1}/${totalCuils} completados. Tiempo restante: ~${tiempoRestanteMin} min`)
        }
        await new Promise(resolve => setTimeout(resolve, PAUSA_MS))
      }
    }
    
    // Resumen final con formato de tabla
    let resumen = `━━━━━━━━━━━━━━━━━━━━\n📊 **RESUMEN NUEVOMONO**\n\n`
    resumen += `📋 Total verificados: ${totalCuils}\n`
    resumen += `✅ ACTIVOS: ${cuilsActivos}\n`
    resumen += `❌ NO ACTIVOS: ${cuilsNoActivos}\n`
    if (cuilsConError > 0) {
      resumen += `🔴 Con errores: ${cuilsConError}\n`
    }
    
    // Lista de resultados en formato tabla
    resumen += `\n━━━━━━━━━━━━━━━━━━━━\n📋 **RESULTADOS**\n\n`
    
    // Agregar CUILs ACTIVOS
    for (const item of resultadosOrdenados) {
      if (item.resultado === 'ACTIVO') {
        resumen += `${item.cuil}\tACTIVO\t${item.categoria}\n`
      }
    }
    
    // Agregar CUILs NO ACTIVOS
    for (const item of resultadosOrdenados) {
      if (item.resultado === 'NO') {
        resumen += `${item.cuil}\tNO\t${item.situacion}\n`
      }
    }
    
    // Dividir mensaje si es muy largo
    const chunks = dividirMensaje(resumen)
    for (const chunk of chunks) {
      await message.channel.send(chunk)
    }
    
    // Mensaje adicional: formato para Google Sheets (orden de verificación)
    let mensajeGoogleSheets = `━━━━━━━━━━━━━━━━━━━━\n📋 **FORMATO PARA COPIAR A GOOGLE SHEETS**\n\`\`\`\n`
    for (const item of resultadosOrdenados) {
      if (item.resultado === 'ACTIVO') {
        mensajeGoogleSheets += `${item.cuil}\tACTIVO\t${item.categoria}\n`
      } else {
        mensajeGoogleSheets += `${item.cuil}\tNO\t${item.situacion}\n`
      }
    }
    mensajeGoogleSheets += `\`\`\``
    
    const chunksSheets = dividirMensaje(mensajeGoogleSheets)
    for (const chunk of chunksSheets) {
      await message.channel.send(chunk)
    }
    
    // Mensaje con la fórmula necesaria
    await message.channel.send(`**FÓRMULA NECESARIA:**\n\`\`\`\n=ARRAYFORMULA(IF(A:A=""; ""; SPLIT(A:A; " ")))\n\`\`\``)
    
    return
  }
  // Si no coincide con ningún comando, mostrar help
  if (t.startsWith('!')) {
    await message.reply(HELP)
  }
})

// ═══════════════════════════════════════════════════════════════
// MANEJO DE ERRORES
// ═══════════════════════════════════════════════════════════════

client.on('error', error => {
  console.error('❌ Error del cliente:', error)
})

process.on('unhandledRejection', error => {
  console.error('❌ Unhandled promise rejection:', error)
})

// ═══════════════════════════════════════════════════════════════
// INICIAR BOT
// ═══════════════════════════════════════════════════════════════

client.login(DISCORD_TOKEN)



