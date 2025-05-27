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
const TRANSCRIPTION_SERVER_URL = process.env.TRANSCRIPTION_SERVER_URL || "http://localhost:8000"; // Added

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
    const response = await axios.delete(`${TRANSCRIPTION_SERVER_URL}/cleanup/${audioId}`);
    res.json(response.data);
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