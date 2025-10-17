// index.js
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import dotenv from 'dotenv'
import fs from 'fs'
import OpenAI from 'openai'

dotenv.config()

const OPENAI_KEY = process.env.OPENAI_API_KEY
if (!OPENAI_KEY) {
  console.error('Falta OPENAI_API_KEY en .env — copiate .env.example y pon tu clave')
  process.exit(1)
}

const openai = new OpenAI({ apiKey: OPENAI_KEY })

// 1. NUEVA ESTRUCTURA DE MEMORIA GLOBAL
// Almacena el historial de conversación por número de WhatsApp (JID)
const CHAT_HISTORY = {} 

// Cargar personalidad
let persona = {
  nombre: 'KekoAI',
  edad: 22,
  origen: 'Paraguay',
  caracter: 'amigable, optimista, empático y divertido',
  habla_como: 'una persona joven, cercana y positiva. Usa emojis, expresiones cotidianas y siempre busca animar a quien habla con él.'
}

try {
  const raw = fs.readFileSync('./persona.json', 'utf8')
  persona = JSON.parse(raw)
} catch (e) {
  console.warn('No se encontró persona.json — usando personalidad por defecto')
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_FOLDER || './auth')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

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

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const message = m.messages[0]
      if (!message || message.key?.fromMe) return

      // Obtener texto y JID
      const text = message.message?.conversation || message.message?.extendedTextMessage?.text
      const from = message.key.remoteJid
      if (!text) return // Ignora mensajes sin texto (como audios, imágenes, etc. — se podría agregar lógica de Whisper aquí)

      console.log(`📩 Mensaje de ${from}: ${text}`)
      
      // 2. GESTIÓN DEL HISTORIAL Y DEFINICIÓN DEL PROMPT
      
      // Si el usuario no tiene historial, inicializarlo con el systemPrompt
      if (!CHAT_HISTORY[from]) {
          const systemPrompt = `Eres ${persona.nombre}, una persona ${persona.caracter}. Hablas como: ${persona.habla_como}. Responde de forma amigable y cercana. No digas que eres un bot. Tu conversación es sobre un tema continuo, así que usa el contexto que te proporciono. Manten la conversación animada.`
          CHAT_HISTORY[from] = [{ role: 'system', content: systemPrompt }]
      }
  
      // Añadir el mensaje del usuario al historial
      CHAT_HISTORY[from].push({ role: 'user', content: text })
  
      // Limitar el historial para no gastar demasiados tokens (ej. solo las últimas 10 interacciones)
      // El System Prompt (índice 0) debe ir siempre primero.
      const conversation = [
          CHAT_HISTORY[from][0], // System Prompt
          ...CHAT_HISTORY[from].slice(-10) // Últimos 10 mensajes
      ]


      // 3. LLAMADA A OPENAI con el historial completo
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: conversation, // Usamos el array con el historial
        max_tokens: 400
      })

      const reply = completion.choices?.[0]?.message?.content || 'Perdón, tuve un problemita y no pude pensar bien. Intentá de nuevo 😊'

      // 4. GUARDAR LA RESPUESTA DEL BOT EN EL HISTORIAL
      CHAT_HISTORY[from].push({ role: 'assistant', content: reply }) 


      // 5. RESPUESTA DE VOZ (TTS - Text-to-Speech)
      const audioFilePath = `./temp_audio_${from}.mp3`;
      
      console.log(`🎙️ Generando respuesta de voz: ${reply}`)

      // Llamada a la API de TTS de OpenAI
      const ttsResponse = await openai.audio.speech.create({
          model: "tts-1",
          voice: "onyx",  // Puedes cambiar a 'alloy', 'shimmer', etc.
          input: reply,   // El texto generado por KekoAI
      });

      // Guardar el archivo de audio en el disco temporalmente
      const buffer = Buffer.from(await ttsResponse.arrayBuffer());
      await fs.promises.writeFile(audioFilePath, buffer);
      
      // Enviar el archivo de audio a WhatsApp como una nota de voz (PTT: Push To Talk)
      await sock.sendMessage(
          from, 
          { 
              audio: { url: audioFilePath }, 
              mimetype: 'audio/mp4', // Formato estándar para WhatsApp
              ptt: true // Esto lo envía como una nota de voz
          }
      );

      // Limpiar el archivo temporal
      await fs.promises.unlink(audioFilePath);
      
      console.log(`✅ Respondido a ${from} con Audio`)
    } catch (err) {
      console.error('Error procesando mensaje:', err)
      // En caso de error, enviar un mensaje de texto para notificar al usuario (fallback)
      const from = m.messages[0].key.remoteJid
      await sock.sendMessage(from, { text: 'Disculpa, tuve un error al procesar tu solicitud o al generar el audio. ¿Podrías intentar de nuevo?' })
    }
  })

  sock.ev.on('creds.update', saveCreds)
}

startBot()