import mongoose from 'mongoose';

const tokenSchema = new mongoose.Schema({
  service: { type: String, required: true, unique: true }, // 'gmail' or 'calendar'
  tokens: { type: Object, required: true }, // The OAuth tokens object
  updatedAt: { type: Date, default: Date.now }
});

export const Token = mongoose.model('Token', tokenSchema);
