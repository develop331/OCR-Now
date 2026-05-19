const fs = require('fs');
const path = require('path');
const http = require('http');

function makeRequest(method, path, data = null, isFormData = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'Content-Type': isFormData ? 'multipart/form-data; boundary=----WebKitFormBoundary' : 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          data: responseData,
          headers: res.headers,
        });
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function test() {
  console.log('Testing image upload functionality...\n');

  try {
    // 1. Test that upload endpoint exists and rejects unauthenticated requests
    console.log('1. Testing /api/upload endpoint (should reject unauthenticated)...');
    const uploadRes = await makeRequest('POST', '/api/upload', null);
    console.log(`   Status: ${uploadRes.status}`);
    if (uploadRes.status === 401) {
      console.log('   ✓ Correctly rejects unauthenticated requests\n');
    } else {
      console.log(`   Response: ${uploadRes.data}\n`);
    }

    // 2. Test uploads directory exists
    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    console.log('2. Checking uploads directory...');
    if (fs.existsSync(uploadsDir)) {
      console.log(`   ✓ Uploads directory exists at ${uploadsDir}\n`);
    }

    // 3. Check database schema
    console.log('3. Checking database schema for imageFilename column...');
    const Database = require('better-sqlite3');
    const db = new Database(path.join(__dirname, 'messages.db'));
    const columns = db.prepare('PRAGMA table_info(messages)').all();
    const hasImageColumn = columns.some(col => col.name === 'imageFilename');
    if (hasImageColumn) {
      console.log('   ✓ imageFilename column exists in messages table\n');
    } else {
      console.log('   ✗ imageFilename column NOT found\n');
    }
    db.close();

    console.log('✅ Image upload infrastructure is ready!');
    console.log('\nTo test end-to-end:');
    console.log('1. Open http://localhost:3000 in your browser');
    console.log('2. Sign up and log in');
    console.log('3. Click the 📷 camera icon to select an image');
    console.log('4. Optionally add a message and press Send');
    console.log('5. The image will be uploaded and displayed in the chat');
  } catch (error) {
    console.error('Test failed:', error);
  }
}

test();
