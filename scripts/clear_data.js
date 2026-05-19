const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, '..', 'messages.db');
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

if (!fs.existsSync(dbPath)) {
  console.error('Database file not found at', dbPath);
  process.exit(1);
}

let db = null;
try {
  db = new Database(dbPath);
  const tables = ['messageReactions', 'messages'];

  const clearTx = db.transaction(() => {
    for (const t of tables) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  });

  clearTx();
  db.close();
  db = null;
  console.log('Message tables cleared.');

  // Run VACUUM in a fresh connection
  try {
    const db2 = new Database(dbPath);
    db2.prepare('VACUUM').run();
    db2.close();
    console.log('VACUUM completed.');
  } catch (err) {
    console.warn('VACUUM failed:', err.message);
  }
} catch (err) {
  console.error('Error clearing database:', err);
  if (db) try { db.close(); } catch (e) {}
  process.exit(2);
}

// Remove uploaded images
if (fs.existsSync(uploadsDir)) {
  const files = fs.readdirSync(uploadsDir);
  for (const f of files) {
    const fp = path.join(uploadsDir, f);
    try {
      if (fs.lstatSync(fp).isFile()) fs.unlinkSync(fp);
    } catch (err) {
      console.warn('Failed to remove', fp, err.message);
    }
  }
  console.log('Uploaded images removed from', uploadsDir);
} else {
  console.log('No uploads directory found at', uploadsDir);
}

console.log('Clear operation completed.');
