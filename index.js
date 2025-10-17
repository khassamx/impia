// index.js
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'

dotenv.config()

// ----------------------------------------------------
// 1. VERIFICACIÓN CRÍTICA DE REQUISITOS (Refuerzo de Instalación)
// ----------------------------------------------------

const OPENAI_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_KEY || OPENAI_KEY === 'sk-xxxxxx') {
  console.error('\n🛑 ERROR CRÍTICO: Falta OPENAI_API_KEY en .env o aún tiene el valor por defecto.')
  console.error('Por favor, copia .env.example, renómbralo a .env y pon tu clave de OpenAI real.')
  process.exit(1)
}

const openai = new OpenAI({ apiKey: OPENAI_KEY })

// ----------------------------------------------------
// 2. CONFIGURACIÓN INICIAL Y CARGA DE PERSONALIDAD
// ----------------------------------------------------

// Memoria Global (se pierde al reiniciar, pero mantiene la conversación viva)
const CHAT_HISTORY = {} 

let persona = {} // Inicializamos persona vacío

try {
  // Intentar cargar persona.json (verificación de archivo)
  const raw = fs.readFileSync('./persona.json', 'utf8')
  persona = JSON.parse(raw)
  console.log(`✅ Personalidad cargada: ${persona.nombre} (${persona.origen}).`)
} catch (e) {
  console.error('\n⚠️ ADVERTENCIA: No se encontró o el formato de persona.json es inválido. Usando personalidad por defecto.')
  persona = {
    nombre: 'KekoAI',
    edad: 22,
    origen: 'Paraguay',
    caracter: 'amigable, optimista, empático y divertido',
    habla_como: 'una persona joven, cercana y positiva. Usa emojis, expresiones cotidianas y siempre busca animar a quien habla con él.'
  }
}

// ----------------------------------------------------
// 3. LÓGICA PRINCIPAL DEL BOT
// ----------------------------------------------------

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_FOLDER || './auth')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  // ... (conexión.update - sin cambios mayores)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log('Escanea este QR con WhatsApp (o abre el archivo QR.png si lo guardaste).')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('🔌 Conexión cerrada. Reconnect?', shouldReconnect)
      if (shouldReconnect) startBot()
    }

    if (connection === 'open') console.log('✅ Conectado a WhatsApp!')
  })
  // ... (fin conexión.update)

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const message = m.messages[0]
      if (!message || message.key?.fromMe) return

      const text = message.message?.conversation || message.message?.extendedTextMessage?.text
      const from = message.key.remoteJid
      if (!text) return 

      console.log(`\n📩 Mensaje de ${from}: ${text}`)
      
      // 1. GESTIÓN DEL HISTORIAL Y DEFINICIÓN DEL PROMPT
      if (!CHAT_HISTORY[from]) {
          const systemPrompt = `Eres ${persona.nombre}, una persona ${persona.caracter}. Hablas como: ${persona.habla_como}. Responde de forma amigable y cercana. No digas que eres un bot. Tu conversación es sobre un tema continuo, así que usa el contexto que te proporciono. Manten la conversación animada.`
          CHAT_HISTORY[from] = [{ role: 'system', content: systemPrompt }]
      }
      CHAT_HISTORY[from].push({ role: 'user', content: text })
  
      const conversation = [
          CHAT_HISTORY[from][0], 
          ...CHAT_HISTORY[from].slice(-10) 
      ]

      // 2. LLAMADA A OPENAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: conversation, 
        max_tokens: 400
      })

      const reply = completion.choices?.[0]?.message?.content || 'Perdón, tuve un problemita y no pude pensar bien. Intentá de nuevo 😊'

      // 3. GUARDAR RESPUESTA
      CHAT_HISTORY[from].push({ role: 'assistant', content: reply }) 


      // 4. RESPUESTA DE VOZ (TTS - Text-to-Speech)
      const audioFilePath = `./temp_audio_${from}.mp3`;
      
      console.log(`🎙️ Generando respuesta de voz...`)

      const ttsResponse = await openai.audio.speech.create({
          model: "tts-1",
          voice: "onyx", 
          input: reply,   
      });

      const buffer = Buffer.from(await ttsResponse.arrayBuffer());
      await fs.promises.writeFile(audioFilePath, buffer);
      
      await sock.sendMessage(
          from, 
          { 
              audio: { url: audioFilePath }, 
              mimetype: 'audio/mp4', 
              ptt: true 
          }
      );

      await fs.promises.unlink(audioFilePath);
      
      console.log(`✅ Respondido a ${from} con Audio`)
    } catch (err) {
      console.error('\n🚨 ERROR procesando mensaje:', err.message)
      // Mensaje de fallback para el usuario
      const from = m.messages[0].key.remoteJid
      await sock.sendMessage(from, { text: '¡Ups! Algo falló en mi cerebro de IA. Verifica tu API Key o intenta más tarde. 🤕' })
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startBot()