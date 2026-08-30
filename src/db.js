import mongoose from 'mongoose';

export async function connectDb(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  return mongoose.connection.readyState === 1;
}

export function dbStatus() {
  switch (mongoose.connection.readyState) {
    case 0: return 'disconnected';
    case 1: return 'connected';
    case 2: return 'connecting';
    case 3: return 'disconnecting';
    default: return 'unknown';
  }
}
