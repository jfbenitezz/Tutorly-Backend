import express from "express";
import cors from "cors";
import path from "path";
import url, { fileURLToPath } from "url";
import ImageKit from "imagekit";
import mongoose from "mongoose";
import Chat from "./models/chat.js";
import UserChats from "./models/userChats.js";
import dotenv from "dotenv";
dotenv.config();
import { ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import axios from "axios"; // Added
import multer from "multer"; // Added
import fs from "fs"; // Added
import FormData from "form-data"; // Added, in case FormData is not global
import AudioRecord from "./models/audioRecord.js"; // Add this at the top

const port = process.env.PORT || 3000;
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// URL base del servidor de transcripción
const TRANSCRIPTION_SERVER_URL = process.env.TRANSCRIPTION_SERVER_URL || "http://localhost:8500"; // Added
const VECTOR_DB_URL = process.env.DB_BASE_URL || "http://localhost:9000";

app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json());

// Configuración de multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage }); // Added

const connect = async () => {
  try {
    await mongoose.connect(process.env.MONGO);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.log(err);
  }
};

// ...existing code...
app.post("/api/chats", ClerkExpressRequireAuth(), async (req, res) => {
  const userId = req.auth.userId;
  const { text } = req.body;

  try {
    // CREATE A NEW CHAT
    const newChat = new Chat({
      userId: userId,
      history: [{ role: "user", parts: [{ text }] }],
    });

    const savedChat = await newChat.save();

    // CHECK IF THE USERCHATS EXISTS
    const userChats = await UserChats.find({ userId: userId });

    // IF DOESN'T EXIST CREATE A NEW ONE AND ADD THE CHAT IN THE CHATS ARRAY
    if (!userChats.length) {
      const newUserChats = new UserChats({
        userId: userId,
        chats: [
          {
            _id: savedChat._id,
            title: text.substring(0, 40),
          },
        ],
      });

      await newUserChats.save();
      // Send response after saving newUserChats
      res.status(201).send(savedChat._id);
    } else {
      // IF EXISTS, PUSH THE CHAT TO THE EXISTING ARRAY
      await UserChats.updateOne(
        { userId: userId },
        {
          $push: {
            chats: {
              _id: savedChat._id,
              title: text.substring(0, 40),
            },
          },
        }
      );

      res.status(201).send(savedChat._id); // Corrected: was newChat._id, should be savedChat._id
    }
  } catch (err) {
    console.log(err);
    res.status(500).send("Error creating chat!");
  }
});

app.get("/api/userchats", ClerkExpressRequireAuth(), async (req, res) => {
  const userId = req.auth.userId;

  try {
    const userChatsResult = await UserChats.findOne({ userId }); // Changed to findOne

    if (userChatsResult && userChatsResult.chats) { // Check if userChatsResult and chats exist
      res.status(200).send(userChatsResult.chats);
    } else {
      res.status(200).send([]); // Send empty array if no chats or user not found
    }
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching userchats!");
  }
});

app.get("/api/chats/:id", ClerkExpressRequireAuth(), async (req, res) => {
  const userId = req.auth.userId;

  try {
    const chat = await Chat.findOne({ _id: req.params.id, userId });
    if (!chat) {
      return res.status(404).send("Chat not found!");
    }
    res.status(200).send(chat);
  } catch (err) {
    console.log(err);
    res.status(500).send("Error fetching chat!");
  }
});

app.delete("/api/userchats/:id", ClerkExpressRequireAuth(), async (req, res) => {
  const userId = req.auth.userId;
  const chatId = req.params.id;

  try {
    // 1. Eliminar el chat en sí
    const deleteChatResult = await Chat.deleteOne({ _id: chatId, userId });

    if (deleteChatResult.deletedCount === 0) {
        return res.status(404).send("Chat not found or user not authorized to delete.");
    }

    // 2. Eliminar la referencia en el documento de UserChats
    await UserChats.updateOne(
      { userId },
      { $pull: { chats: { _id: chatId } } }
    );

    res.status(200).send({ message: "Chat eliminado con éxito" });
  } catch (err) {
    console.error("Error al eliminar chat:", err);
    res.status(500).send("Error al eliminar chat");
  }
});


app.put("/api/chats/:id", ClerkExpressRequireAuth(), async (req, res) => {
  const userId = req.auth.userId;

  const { question, answer, img } = req.body;

  const newItems = [
    ...(question
      ? [{ role: "user", parts: [{ text: question }], ...(img && { img }) }]
      : []),
    { role: "model", parts: [{ text: answer }] },
  ];

  try {
    const updatedChatResult = await Chat.updateOne( // Renamed for clarity
      { _id: req.params.id, userId },
      {
        $push: {
          history: {
            $each: newItems,
          },
        },
      }
    );
    if (updatedChatResult.matchedCount === 0) {
        return res.status(404).send("Chat not found or user not authorized.");
    }
    if (updatedChatResult.modifiedCount === 0 && updatedChatResult.matchedCount === 1) {
        // Optionally, you could send a 200 with a message that no changes were made,
        // or retrieve and send the chat if that's desired behavior.
        // For now, sending the result as is.
    }
    // Sending back a success message or the updated chat document might be more useful
    // For now, sending the update result.
    res.status(200).send({ message: "Conversation updated successfully." });
  } catch (err) {
    console.log(err);
    res.status(500).send("Error adding conversation!");
  }
});

// Rutas proxy para el servidor de transcripción (Added)
// 1. Subir audio
app.post("/api/audio/upload", ClerkExpressRequireAuth(), upload.single("file"), async (req, res) => { // Cambiado de "audio" a "file"
  const userId = req.auth.userId; // From Clerk
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No se proporcionó ningún archivo" });
    }

    const formData = new FormData();
    // Cuando reenvías al servidor de transcripción, asegúrate de que el nombre del campo
    // ("file" aquí) coincida con lo que espera el endpoint /upload de FastAPI.
    formData.append("file", fs.createReadStream(req.file.path), req.file.originalname);

    const response = await axios.post(`${TRANSCRIPTION_SERVER_URL}/upload`, formData, {
      headers: {
        ...formData.getHeaders(), // Important for multipart/form-data with form-data library
      },
    });

      // Save the audio metadata in MongoDB
      await AudioRecord.create({
        audioId: response.data.audio_id, // depends on what FastAPI returns
        userId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        status: "uploaded",
      });

    // Clean up the uploaded file after forwarding
    fs.unlink(req.file.path, (err) => {
        if (err) console.error("Error deleting uploaded file:", err);
    });

    res.json(response.data);
  } catch (error) {
    console.error("Error al subir el audio (ruta /api/audio/upload):", error.response ? error.response.data : error.message);
    // Clean up the uploaded file in case of an error too
    if (req.file && req.file.path) {
        fs.unlink(req.file.path, (errUnlink) => { // Usar un nombre de variable diferente para el error de unlink
            if (errUnlink) console.error("Error deleting uploaded file after error:", errUnlink);
        });
    }
    // Devuelve el error específico de la ruta en lugar de dejar que caiga al manejador global
    // para dar más contexto si es posible.
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : { error: "Error interno al procesar la subida del audio", details: error.message };
    res.status(status).json(data);
  }
});

// 2. Verificar estado de un audio
app.get("/api/audio/status/:audioId", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const { audioId } = req.params;
    const response = await axios.get(`${TRANSCRIPTION_SERVER_URL}/status/${audioId}`);
    res.json(response.data);
  } catch (error) {
    console.error("Error al verificar el estado del audio:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Error al verificar el estado del audio", details: error.message });
  }
});

// 3. Procesar un audio
app.post("/api/audio/process/:audioId", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const { audioId } = req.params;
    console.log(`Backend: Procesando audio ${audioId} con cuerpo:`, req.body);
    const response = await axios.post(`${TRANSCRIPTION_SERVER_URL}/process/${audioId}`, req.body);
    console.log(`Backend: Respuesta de FastAPI /process/${audioId}:`, response.data); // LOG DETALLADO
    res.json(response.data);
  } catch (error) {
    console.error("Error al procesar el audio (backend):", error.response ? error.response.data : error.message);
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : { error: "Error al procesar el audio", details: error.message };
    res.status(status).json(data);
  }
});

// 4. Transcribir un audio
app.post("/api/audio/transcribe/:audioId", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const { audioId } = req.params;
    const { use_fallback } = req.query; // TOMA 'use_fallback' DE LOS QUERY PARAMS DE ESTA RUTA

    let transcriptionServiceUrl = `${TRANSCRIPTION_SERVER_URL}/transcribe/${audioId}`;

    if (use_fallback !== undefined) {
      const fallbackValue = String(use_fallback).toLowerCase() === 'true';
      transcriptionServiceUrl += `?use_fallback=${fallbackValue}`; // AÑADE use_fallback A LA URL DEL SERVICIO
    }

    // ENVÍA UN CUERPO VACÍO AL SERVICIO DE TRANSCRIPCIÓN
    const response = await axios.post(transcriptionServiceUrl, {}); 
    await AudioRecord.findOneAndUpdate(
      { audioId },
      { status: "transcribed", lastUpdated: new Date(), transcriptionResult: response.data },
    );
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Error al transcribir el audio:", error.response ? error.response.data : error.message);
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : { error: "Error al transcribir el audio", details: error.message };
    res.status(status).json(data);
  }
});

// 5. Limpiar/eliminar un audio
app.delete("/api/audio/cleanup/:audioId", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const { audioId } = req.params;
    
    // Call the external cleanup service
    const response = await axios.delete(`${TRANSCRIPTION_SERVER_URL}/cleanup/${audioId}`);
    
    // Remove the audio record from MongoDB
    const deleteResult = await AudioRecord.deleteOne({ audioId });
    
    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({ error: "Audio record not found" });
    }

    res.json({ message: "Audio cleaned up successfully", details: response.data });
  } catch (error) {
    console.error("Error al limpiar el audio:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Error al limpiar el audio", details: error.message });
  }
});

app.get("/api/audio/list", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const userId = req.auth.userId;
    const records = await AudioRecord.find({ userId }).sort({ createdAt: -1 });
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: "Error fetching audio records", details: error.message });
  }
});

app.get("/api/audio/:audioId/transcription", ClerkExpressRequireAuth(), async (req, res) => {
  try {
    const { audioId } = req.params;
    const record = await AudioRecord.findOne({ audioId }, { transcriptionResult: 1 });
    if (!record) {
      return res.status(404).json({ error: "Audio record not found" });
    }
    res.json(record.transcriptionResult);
  } catch (error) {
    res.status(500).json({ error: "Error fetching audio transcription", details: error.message });
  }
})

// End of Added audio routes

app.use((err, req, res, next) => {
  console.error(err.stack);
  // Check if the error is from Clerk
  if (err.message && (err.message.toLowerCase().includes('unauthenticated') || err.message.toLowerCase().includes('clerk'))) {
    return res.status(401).send("Unauthenticated!");
  }
  // For other errors, you might want a generic 500
  res.status(500).send("Something broke!");
});

// Endpoints for LLM module
const FASTAPI_BASE_URL = process.env.LLM_BASE_URL|| 'http://localhost:8080';

app.get('/api/files', async (req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_BASE_URL}/list_files/`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching files:', error.message);
    res.status(500).json({ error: 'Error connecting to FastAPI' });
  }
});

app.get('/api/files/:filename', async (req, res) => {
  const { filename } = req.params;
  try {
    const response = await axios.get(`${FASTAPI_BASE_URL}/get_file/${filename}`, {
      responseType: 'stream',
    });

    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error downloading file:', error.message);
    res.status(500).json({ error: 'Error downloading file from FastAPI' });
  }
});

app.post('/api/generar_esquema', ClerkExpressRequireAuth(), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }
  const form = new FormData();
  form.append('file', fs.createReadStream(req.file.path), req.file.originalname);

  try {
    const response = await axios.post(
      `${FASTAPI_BASE_URL}/generar_esquema/`,
      form,
      { 
        headers: form.getHeaders(),
        responseType: 'stream' 
      }
    );
    res.setHeader('Content-Disposition', response.headers['content-disposition'] || `attachment; filename="${req.file.originalname.replace(/\.txt$/i, '_esquema.txt')}"`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error generating schema:', error.response ? error.response.data : error.message);
    res.status(error.response?.status || 500).json({ error: 'Error generating schema from FastAPI', details: error.message });
  } finally {
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('Error deleting uploaded file for schema generation:', err);
    });
  }
});

// Endpoint: POST /api/generar_apuntes
app.post('/api/generar_apuntes', ClerkExpressRequireAuth(), upload.fields([
  { name: 'transcripcion_file', maxCount: 1 },
  { name: 'esquema_file', maxCount: 1 }
]), async (req, res) => {
  const files = req.files;
  if (!files || !files['transcripcion_file'] || !files['esquema_file']) {
    return res.status(400).send('Missing files. Both transcripcion_file and esquema_file are required.');
  }

  const transcripcionFile = files['transcripcion_file'][0];
  const esquemaFile = files['esquema_file'][0];
  const form = new FormData();
  form.append('transcripcion_file', fs.createReadStream(transcripcionFile.path), transcripcionFile.originalname);
  form.append('esquema_file', fs.createReadStream(esquemaFile.path), esquemaFile.originalname);

  try {
    const response = await axios.post(
      `${FASTAPI_BASE_URL}/generar_apuntes/`,
      form,
      { 
        headers: form.getHeaders(),
        responseType: 'stream' 
      }
    );
    res.setHeader('Content-Disposition', response.headers['content-disposition'] || `attachment; filename="apuntes.md"`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error generating notes:', error.response ? error.response.data : error.message);
    res.status(error.response?.status || 500).json({ error: 'Error generating notes from FastAPI', details: error.message });
  } finally {
    fs.unlink(transcripcionFile.path, (err) => {
      if (err) console.error('Error deleting uploaded transcripcion_file for notes generation:', err);
    });
    fs.unlink(esquemaFile.path, (err) => {
      if (err) console.error('Error deleting uploaded esquema_file for notes generation:', err);
    });
  }
});

// Endpoint: POST /api/generar_apuntes_gemini
app.post('/api/generar_apuntes_gemini', ClerkExpressRequireAuth(), upload.fields([
  { name: 'esquema_file', maxCount: 1 },
  { name: 'transcripcion_file', maxCount: 1 }
]), async (req, res) => {
  const files = req.files;
  if (!files || !files['esquema_file'] || !files['transcripcion_file']) {
    return res.status(400).send('Missing files. Both esquema_file and transcripcion_file are required.');
  }

  const esquemaFile = files['esquema_file'][0];
  const transcripcionFile = files['transcripcion_file'][0];
  const form = new FormData();
  form.append('esquema_file', fs.createReadStream(esquemaFile.path), esquemaFile.originalname);
  form.append('transcripcion_file', fs.createReadStream(transcripcionFile.path), transcripcionFile.originalname);

  try {
    const response = await axios.post(
      `${FASTAPI_BASE_URL}/generar_apuntes_gemini/`,
      form,
      { 
        headers: form.getHeaders(),
        responseType: 'stream' 
      }
    );
    res.setHeader('Content-Disposition', response.headers['content-disposition'] || `attachment; filename="apuntes_gemini.md"`);
    response.data.pipe(res);
  } catch (error) {
    console.error('Error generating Gemini notes:', error.response ? error.response.data : error.message);
    res.status(error.response?.status || 500).json({ error: 'Error generating Gemini notes from FastAPI', details: error.message });
  } finally {
    fs.unlink(esquemaFile.path, (err) => {
      if (err) console.error('Error deleting uploaded esquema_file for Gemini notes:', err);
    });
    fs.unlink(transcripcionFile.path, (err) => {
      if (err) console.error('Error deleting uploaded transcripcion_file for Gemini notes:', err);
    });
  }
});

// End LLM module endpoints

// Add this endpoint after all your other routes but before the error handler
app.delete("/api/cleanup", async (req, res) => {
  try {
    // Verify the user is an admin (Clerk will handle this with adminOnly: true)
    
    // Delete all documents from each collection
    const [chatResult, userChatsResult, audioResult] = await Promise.all([
      Chat.deleteMany({}),
      UserChats.deleteMany({}),
      AudioRecord.deleteMany({})
    ]);

    res.status(200).json({
      message: "Database cleanup completed successfully",
      results: {
        chatsDeleted: chatResult.deletedCount,
        userChatsDeleted: userChatsResult.deletedCount,
        audioRecordsDeleted: audioResult.deletedCount
      }
    });
  } catch (err) {
    console.error("Error during cleanup:", err);
    res.status(500).json({ 
      error: "Error during database cleanup",
      details: err.message 
    });
  }
});

app.post("/api/vector-db/upload-pdf", ClerkExpressRequireAuth(), upload.single("pdfFile"), async (req, res) => {
  if (!VECTOR_DB_URL) {
    console.error("VECTOR_DB_URL is not defined in .env file.");
    return res.status(500).json({ error: "Service configuration error: VECTOR_DB_URL is missing." });
  }
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file provided." });
    }
    const formData = new FormData();
    // El endpoint Python espera el campo "file" según el código FastAPI
    formData.append("file", fs.createReadStream(req.file.path), req.file.originalname);
  
    const response = await axios.post(`${VECTOR_DB_URL}/upload-pdf/`, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });
    // Limpiar el archivo temporal
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Error deleting temporary PDF file:", err);
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Error uploading PDF to vector DB:", error.response ? error.response.data : error.message);
    
    // Limpiar archivo temporal en caso de error
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, (unlinkErr) => {
        if (unlinkErr) console.error("Error deleting temporary PDF file after error:", unlinkErr);
      });
    }
    
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : { error: "Error processing PDF upload.", details: error.message };
    res.status(status).json(data);
  }
});

// Endpoint to empty the vector DB collection
app.post("/api/vector-db/empty-collection", ClerkExpressRequireAuth(), async (req, res) => {
  if (!VECTOR_DB_URL) {
    console.error("VECTOR_DB_URL is not defined in .env file.");
    return res.status(500).json({ error: "Service configuration error: VECTOR_DB_URL is missing." });
  }
  try {
    const response = await axios.post(`${VECTOR_DB_URL}/empty-collection/`);
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error("Error emptying vector DB collection:", error.response ? error.response.data : error.message);
    const status = error.response ? error.response.status : 500;
    const data = error.response ? error.response.data : { error: "Error communicating with vector DB service.", details: error.message };
    res.status(status).json(data);
  }
});

// PRODUCTION
// This existing block seems correct for serving your client's dist folder.
// The new code had a similar block for "client/build", ensure this path is correct for your setup.
if (process.env.NODE_ENV !== "development") { // Or use: process.env.NODE_ENV === "production"
    app.use(express.static(path.join(__dirname, "../client/dist")));

    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "../client/dist", "index.html"));
    });
}


app.listen(port, () => {
  connect();
  console.log(`Server running on ${port}`); // Use template literal for port
});