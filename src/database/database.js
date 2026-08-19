const mongoose = require('mongoose');

const connectDatabase = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Auto-create indexes defined in schemas
      autoIndex: true,
      // Auto-create collections when models are used
      autoCreate: true,
    });
    
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    console.log(`Database: ${conn.connection.name}`);
    
    // Skip index sync in production for faster startup (~3s saved).
    // Indexes only change during code deploys — run once manually after deploy
    // or set SYNC_INDEXES=true for that single restart.
    if (process.env.NODE_ENV === 'production' && process.env.SYNC_INDEXES !== 'true') {
      console.log('⏭️  Index sync skipped (production). Set SYNC_INDEXES=true to force.');
      return;
    }

    // Sync all models - ensures collections and indexes exist
    console.log('🔄 Syncing database models...');
    
    // Get all registered models
    const models = mongoose.modelNames();
    console.log(`   Found ${models.length} models: ${models.join(', ')}`);
    
    // Sync indexes for all models
    for (const modelName of models) {
      const model = mongoose.model(modelName);
      await model.syncIndexes();
      console.log(`   ✅ Synced indexes for ${modelName}`);
    }
    
    console.log('✅ Database sync complete');
    
  } catch (error) {
    console.error(`❌ Database connection error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDatabase;
