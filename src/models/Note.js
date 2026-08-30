import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
  text: { type: String, required: true },
  done: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

noteSchema.index({ createdAt: -1 });

export const Note = mongoose.model('Note', noteSchema);
