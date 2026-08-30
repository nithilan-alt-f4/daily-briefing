import mongoose from 'mongoose';

const itemSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['nps', 'gmail', 'news'],
    required: true
  },
  type: {
    type: String,
    enum: ['assignment', 'notification', 'circular', 'email', 'news'],
    required: true
  },
  externalId: { type: String },
  title: { type: String, required: true },
  content: { type: String, default: '' },
  summary: { type: String },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  postedDate: { type: Date },
  isRead: { type: Boolean, default: false },
  isCompleted: { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

itemSchema.index({ source: 1, type: 1, externalId: 1 }, { unique: true, sparse: true });
// News items get wiped daily; keep queries fast on source+createdAt
itemSchema.index({ source: 1, createdAt: -1 });

export const Item = mongoose.model('Item', itemSchema);
