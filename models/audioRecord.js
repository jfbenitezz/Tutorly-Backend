import mongoose from "mongoose";

const AudioRecordSchema = new mongoose.Schema({
  audioId: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: String,
    required: true,
  },
  filename: {
    type: String,
  },
  originalName: {
    type: String,
  },
  status: {
    type: String,
    enum: ["uploaded", "processing", "transcribed", "error", "cleaned"],
    default: "uploaded",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
  transcriptionResult: {
    type: mongoose.Schema.Types.Mixed, // Optional: store actual transcription result
  },
});

export default mongoose.model("AudioRecord", AudioRecordSchema);
