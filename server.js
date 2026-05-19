const express = require('express');
const http = require('http');
const https = require('https');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { Server } = require('socket.io');
// import { PORT, HTTPS_CONFIG } from "./src/config.js";
const { PORT, HTTPS_CONFIG } = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Optional NSFW classifier (best-effort)
let nsfwModel = null;
let tf = null;
let nsfwAvailable = false;
let nsfwLoadError = null;

const nsfwModelReady = (async () => {
  try {
     // These packages are optional; install with:
     // npm install @tensorflow/tfjs nsfwjs
     tf = require('@tensorflow/tfjs');
     await tf.setBackend('cpu');
     await tf.ready();
    const nsfw = require('nsfwjs');
    // load model from CDN (nsfwjs will fetch) or local cache
    nsfwModel = await nsfw.load();
    nsfwAvailable = true;
    console.log('NSFW classifier loaded');
  } catch (err) {
    nsfwLoadError = err;
    console.warn('NSFW classifier unavailable (install @tensorflow/tfjs-node and nsfwjs to enable):', err.message);
  }
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Setup image uploads directory
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Setup multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const port = process.env.PORT || 443;
const authSecret = process.env.AUTH_SECRET || 'ocr-now-dev-secret';
const db = new Database(path.join(__dirname, 'messages.db'));
const maxMessages = 100;
const imagesLogPath = path.join(__dirname, 'images.txt');

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    passwordSalt TEXT NOT NULL,
    age INTEGER NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messageReactions (
    messageId TEXT NOT NULL,
    userId TEXT NOT NULL,
    reaction INTEGER NOT NULL CHECK (reaction IN (1, -1)),
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (messageId, userId)
  );
`);

const messageColumns = new Set(
  db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name),
);

if (!messageColumns.has('userId')) {
  db.exec('ALTER TABLE messages ADD COLUMN userId TEXT');
}

if (!messageColumns.has('username')) {
  db.exec('ALTER TABLE messages ADD COLUMN username TEXT');
}

if (!messageColumns.has('imageFilename')) {
  db.exec('ALTER TABLE messages ADD COLUMN imageFilename TEXT');
}

db.exec(`
  UPDATE messages
  SET userId = COALESCE(userId, 'legacy'),
      username = COALESCE(username, name, 'Legacy')
`);

const getUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare('SELECT id, username, age, createdAt FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT INTO users (id, username, passwordHash, passwordSalt, age, createdAt)
  VALUES (@id, @username, @passwordHash, @passwordSalt, @age, @createdAt)
`);
const upsertMessageReaction = db.prepare(`
  INSERT INTO messageReactions (messageId, userId, reaction, createdAt, updatedAt)
  VALUES (@messageId, @userId, @reaction, @createdAt, @updatedAt)
  ON CONFLICT(messageId, userId) DO UPDATE SET
    reaction = excluded.reaction,
    updatedAt = excluded.updatedAt
`);
const selectMessageReactions = db.prepare(`
  SELECT
    messageId,
    SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END) AS likes,
    SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END) AS dislikes
  FROM messageReactions
  GROUP BY messageId
`);
const getUserReaction = db.prepare(`
  SELECT reaction FROM messageReactions WHERE messageId = ? AND userId = ?
`);
const deleteMessageReaction = db.prepare(`
  DELETE FROM messageReactions WHERE messageId = ? AND userId = ?
`);
const insertMessage = messageColumns.has('name')
  ? db.prepare(`
    INSERT INTO messages (id, clientId, name, text, timestamp, userId, username, imageFilename)
    VALUES (@id, @clientId, @name, @text, @timestamp, @userId, @username, @imageFilename)
  `)
  : db.prepare(`
    INSERT INTO messages (id, userId, username, text, timestamp, imageFilename)
    VALUES (@id, @userId, @username, @text, @timestamp, @imageFilename)
  `);
const selectRecentMessages = db.prepare(`
  SELECT
    id,
    COALESCE(userId, clientId) AS userId,
    COALESCE(username, name) AS username,
    text,
    timestamp,
    imageFilename,
    COALESCE(reactionStats.likes, 0) AS likes,
    COALESCE(reactionStats.dislikes, 0) AS dislikes
  FROM messages
  LEFT JOIN (
    SELECT
      messageId,
      SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM messageReactions
    GROUP BY messageId
  ) AS reactionStats ON reactionStats.messageId = messages.id
  ORDER BY datetime(timestamp) DESC, rowid DESC
  LIMIT ?
`);
const selectMessageById = db.prepare(`
  SELECT
    id,
    COALESCE(userId, clientId) AS userId,
    COALESCE(username, name) AS username,
    text,
    timestamp,
    imageFilename,
    COALESCE(reactionStats.likes, 0) AS likes,
    COALESCE(reactionStats.dislikes, 0) AS dislikes
  FROM messages
  LEFT JOIN (
    SELECT
      messageId,
      SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM messageReactions
    GROUP BY messageId
  ) AS reactionStats ON reactionStats.messageId = messages.id
  WHERE messages.id = ?
`);

function parseCookies(cookieHeader) {
  const cookies = {};

  if (!cookieHeader) {
    return cookies;
  }

  cookieHeader.split(';').forEach((entry) => {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const value = entry.slice(separatorIndex + 1).trim();
    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function timingSafeEqualString(first, second) {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);

  if (firstBuffer.length !== secondBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function signValue(value) {
  const signature = base64UrlEncode(crypto.createHmac('sha256', authSecret).update(value).digest());
  return `${value}.${signature}`;
}

function verifySignedValue(signedValue) {
  if (typeof signedValue !== 'string') {
    return null;
  }

  const separatorIndex = signedValue.lastIndexOf('.');
  if (separatorIndex === -1) {
    return null;
  }

  const value = signedValue.slice(0, separatorIndex);
  const signature = signedValue.slice(separatorIndex + 1);
  const expectedSignature = base64UrlEncode(crypto.createHmac('sha256', authSecret).update(value).digest());

  if (!timingSafeEqualString(signature, expectedSignature)) {
    return null;
  }

  return value;
}

function hashPassword(password, passwordSalt) {
  return crypto.scryptSync(password, passwordSalt, 64).toString('hex');
}

function verifyPassword(password, passwordSalt, expectedHash) {
  const actualHash = hashPassword(password, passwordSalt);
  return timingSafeEqualString(actualHash, expectedHash);
}

function setAuthCookie(res, userId) {
  res.setHeader('Set-Cookie', `auth_user=${encodeURIComponent(signValue(userId))}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'auth_user=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

function getAuthenticatedUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const userId = verifySignedValue(cookies.auth_user);

  if (!userId) {
    return null;
  }

  return getUserById.get(userId) || null;
}

function createUser(username, password, age) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: hashPassword(password, passwordSalt),
    passwordSalt,
    age,
    createdAt: new Date().toISOString(),
  };

  insertUser.run(user);
  return user;
}

function getMessageReactionCounts(messageId) {
  const reactionRow = db.prepare(`
    SELECT
      SUM(CASE WHEN reaction = 1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN reaction = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM messageReactions
    WHERE messageId = ?
  `).get(messageId);

  return {
    messageId,
    likes: reactionRow?.likes || 0,
    dislikes: reactionRow?.dislikes || 0,
  };
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/images.txt', (req, res) => {
  res.type('text/plain');
  return res.sendFile(imagesLogPath);
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Get authenticated user
    const user = getAuthenticatedUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log('[upload] incoming image', {
      userId: user.id,
      username: user.username,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });

    const inputMetadata = await sharp(req.file.buffer).metadata();
    const width = Number.isInteger(inputMetadata.width) ? inputMetadata.width : 0;
    const height = Number.isInteger(inputMetadata.height) ? inputMetadata.height : 0;
    const pixelCount = width > 0 && height > 0 ? width * height : 0;

    if (pixelCount > 0) {
      await fs.promises.appendFile(imagesLogPath, `${pixelCount}\n`);
      console.log('[upload] logged pixel count', {
        userId: user.id,
        username: user.username,
        width,
        height,
        pixelCount,
        imagesLogPath,
      });
    } else {
      console.warn('[upload] could not determine pixel count', {
        userId: user.id,
        username: user.username,
        originalName: req.file.originalname,
      });
    }

    // Wait for the NSFW model to settle before deciding whether this upload is allowed.
    await nsfwModelReady;

    if (!nsfwAvailable || !nsfwModel || !tf) {
      console.warn('[upload] blocked because NSFW classifier is unavailable', {
        userId: user.id,
        username: user.username,
        reason: nsfwLoadError ? nsfwLoadError.message : 'classifier not ready',
      });
      return res.status(503).json({ error: 'Upload blocked: moderation unavailable' });
    }

    // Generate unique filename
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.webp`;
    const filepath = path.join(uploadsDir, filename);

    // Resize and compress image to WebP into a buffer first
    const processedBuffer = await sharp(req.file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    console.log('[upload] processed image buffer', {
      userId: user.id,
      username: user.username,
      filename,
      bytes: processedBuffer.length,
    });

    // Best-effort NSFW classification if available
    try {
      if (nsfwAvailable && nsfwModel && tf) {
          const resizedForModel = await sharp(processedBuffer)
            .resize(224, 224, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

          const imageTensor = tf.tensor3d(
            new Uint8Array(resizedForModel.data),
            [resizedForModel.info.height, resizedForModel.info.width, resizedForModel.info.channels],
            'int32'
          );

        const predictions = await nsfwModel.classify(imageTensor);
        imageTensor.dispose();

        console.log('[upload] nsfw predictions', {
          filename,
          predictions,
        });

        // Check for explicit categories that indicate NSFW content
        const nsfwProb = predictions.reduce((acc, p) => {
          if (p.className === 'Porn' || p.className === 'Hentai' || p.className === 'Sexy') {
            return Math.max(acc, p.probability || 0);
          }
          return acc;
        }, 0);

        console.log('[upload] nsfw score', {
          filename,
          nsfwProb,
          threshold: 0.4,
          allowed: nsfwProb < 0.4,
        });

        if (nsfwProb >= 0.4) {
          console.warn('Blocked upload due to NSFW classifier (probability=', nsfwProb, ')');
          return res.status(403).json({ error: 'Upload blocked: image flagged as NSFW' });
        }
      }
    } catch (err) {
      console.warn('NSFW classification failed, blocking upload:', err.message);
      return res.status(503).json({ error: 'Upload blocked: moderation unavailable' });
    }

    // Simple gore (NSFL) heuristic: look for large amounts of intense red
    try {
      const { data, info } = await sharp(processedBuffer).raw().toBuffer({ resolveWithObject: true });
      const pixelCount = info.width * info.height;
      let redPixels = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // red-dominant and fairly bright
        if (r > 150 && r > g + 30 && r > b + 30) redPixels++;
      }
      const redRatio = redPixels / pixelCount;

      console.log('[upload] gore heuristic', {
        filename,
        width: info.width,
        height: info.height,
        channels: info.channels,
        pixelCount,
        redPixels,
        redRatio,
        threshold: 0.2,
        allowed: redRatio <= 0.2,
      });

      if (redRatio > 0.2) {
        console.warn('Blocked upload due to gore heuristic (red ratio=', redRatio, ')');
        return res.status(403).json({ error: 'Upload blocked: image flagged as potentially graphic' });
      }
    } catch (err) {
      console.warn('Gore heuristic failed, blocking upload:', err.message);
      return res.status(503).json({ error: 'Upload blocked: moderation unavailable' });
    }

    // Write final processed buffer to disk
    await fs.promises.writeFile(filepath, processedBuffer);
    console.log('[upload] final decision', {
      filename,
      decision: 'allowed',
      storedPath: filepath,
    });
    return res.json({ filename });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/post/:messageId', (req, res) => {
  const messageId = typeof req.params.messageId === 'string' ? req.params.messageId.trim() : '';
  const message = selectMessageById.get(messageId);

  if (!message) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Post Not Found</title></head>
        <body style="font-family: Arial; padding: 20px;">
          <h1>Post not found</h1>
          <p><a href="/">Back to chat</a></p>
        </body>
      </html>
    `);
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Post by ${message.username}</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <div class="safety-banner" role="note" aria-label="Age requirement notice">
          Unfortunately, due to the Online Safety Act 2023, all users of this app (application) must be at least 14 years of age
        </div>
        <main class="app-shell">
          <div class="single-post-page">
            <div class="single-post-header">
              <a href="/" class="back-link">← Back to chat</a>
            </div>
            <div class="single-post-container">
              <div class="message" data-message-id="${message.id}">
                <div class="message-meta">
                  <strong>${message.username}</strong>
                  <span>${new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <p class="message-text">${message.text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                ${message.imageFilename ? `<img src="/uploads/${message.imageFilename}" alt="Message image" class="message-image">` : ''}
                <div id="likes-summary" class="likes-summary">
                  <p>There are ${message.likes || 0} likes.</p>
                  <p>There are ${message.dislikes || 0} dislikes.</p>
                  <p>${(message.likes || 0) > (message.dislikes || 0) ? 'There are more likes than dislikes.' : (message.likes || 0) < (message.dislikes || 0) ? 'There are more dislikes than likes.' : 'There is the same number of likes and dislikes'}</p>
                </div>
                <div class="message-reactions">
                  <button class="reaction-button like-button" data-reaction="like">Like (<span class="like-count">${message.likes || 0}</span>)</button>
                  <button class="reaction-button dislike-button" data-reaction="dislike">Dislike (<span class="dislike-count">${message.dislikes || 0}</span>)</button>
                </div>
              </div>
            </div>
          </div>
        </main>
        <style>
          .single-post-page {
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 16px;
          }
          .single-post-header {
            margin-bottom: 16px;
          }
          .back-link {
            color: #0066cc;
            text-decoration: none;
            font-size: 0.95rem;
          }
          .back-link:hover {
            text-decoration: underline;
          }
          .single-post-container {
            max-width: 900px;
            margin: 0 auto;
            border: 1px solid #ccc;
            padding: 16px;
            border-radius: 4px;
          }
          .message-image {
            max-width: 100%;
            height: auto;
            margin-top: 12px;
            border-radius: 4px;
          }
        </style>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const messageId = '${message.id}';
          let socket = null;
          let currentUser = null;
          let userReaction = null;

          async function loadCurrentUser() {
            try {
              const response = await fetch('/auth/me', { credentials: 'same-origin' });
              if (response.ok) {
                const data = await response.json();
                if (data.authenticated && data.user) {
                  currentUser = data.user;
                  connectSocket();
                }
              }
            } catch (error) {
              console.error('Failed to load current user:', error);
            }
          }

          function connectSocket() {
            if (!currentUser) return;
            
            socket = io();
            
            socket.on('chat:reaction', (reactionUpdate) => {
              if (reactionUpdate.messageId === messageId) {
                updateReactions(reactionUpdate);
                if (reactionUpdate.userId === currentUser.id) {
                  userReaction = reactionUpdate.reaction === 1 ? 'like' : reactionUpdate.reaction === -1 ? 'dislike' : null;
                  updateButtonStates();
                }
              }
            });
          }

          function updateReactions(reactionUpdate) {
            const likes = reactionUpdate.likes || 0;
            const dislikes = reactionUpdate.dislikes || 0;

            const likeEl = document.querySelector('.like-count');
            const dislikeEl = document.querySelector('.dislike-count');
            if (likeEl) likeEl.textContent = likes;
            if (dislikeEl) dislikeEl.textContent = dislikes;

            const summaryEl = document.getElementById('likes-summary');
            if (summaryEl) {
              const outcome = likes > dislikes
                ? 'There are more likes than dislikes.'
                : likes < dislikes
                ? 'There are more dislikes than likes.'
                : 'There is the same number of likes and dislikes';

              summaryEl.innerHTML = '<p>There are ' + likes + ' likes.</p>' +
                                     '<p>There are ' + dislikes + ' dislikes.</p>' +
                                     '<p>' + outcome + '</p>';
            }
          }

          function updateButtonStates() {
            const likeBtn = document.querySelector('.like-button');
            const dislikeBtn = document.querySelector('.dislike-button');
            
            likeBtn.classList.toggle('selected', userReaction === 'like');
            dislikeBtn.classList.toggle('selected', userReaction === 'dislike');
          }

          function sendReaction(reaction) {
            if (!socket) {
              return;
            }
            socket.emit('chat:reaction', { messageId, reaction });
          }

          document.querySelector('.like-button').addEventListener('click', () => {
            sendReaction('like');
          });

          document.querySelector('.dislike-button').addEventListener('click', () => {
            sendReaction('dislike');
          });

          loadCurrentUser();
        </script>
      </body>
    </html>
  `;

  res.send(html);
});

app.get('/api/post/:messageId', (req, res) => {
  const messageId = typeof req.params.messageId === 'string' ? req.params.messageId.trim() : '';
  const message = selectMessageById.get(messageId);

  if (!message) {
    return res.status(404).json({ error: 'Post not found' });
  }

  return res.json(message);
});

app.get('/auth/me', (req, res) => {
  const user = getAuthenticatedUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({ authenticated: true, user });
});

app.post('/auth/signup', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const age = Number.parseInt(req.body.age, 10);

  if (!username || username.length < 3) {
    return res.status(400).json({ error: 'signup = False' });
  }

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'signup = False' });
  }

  if (!Number.isInteger(age) || age < 14) {
    return res.status(400).json({ error: 'signup = False' });
  }

  if (getUserByUsername.get(username)) {
    return res.status(409).json({ error: 'signup = False' });
  }

  createUser(username, password, age);
  const user = getUserByUsername.get(username);
  setAuthCookie(res, user.id);

  return res.status(201).json({ user: getUserById.get(user.id) });
});

app.post('/auth/login', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ error: 'login = False' });
  }

  const user = getUserByUsername.get(username);
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return res.status(401).json({ error: 'login = False' });
  }

  setAuthCookie(res, user.id);
  return res.json({ user: getUserById.get(user.id) });
});

app.post('/auth/logout', (req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  const userId = verifySignedValue(cookies.auth_user);
  const user = userId ? getUserById.get(userId) : null;

  if (!user) {
    return next(new Error('authentication required'));
  }

  socket.user = user;
  return next();
});

io.on('connection', (socket) => {
  const history = selectRecentMessages.all(maxMessages).reverse();
  socket.emit('chat:history', history);

  socket.on('chat:message', (payload) => {
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    const imageFilename = typeof payload?.imageFilename === 'string' ? payload.imageFilename.trim() : null;

    if (!text && !imageFilename) {
      return;
    }

    const messageId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message = {
      id: messageId,
      clientId: messageId,
      userId: socket.user.id,
      username: socket.user.username,
      name: socket.user.username,
      text,
      timestamp: new Date().toISOString(),
      imageFilename: imageFilename || null,
      likes: 0,
      dislikes: 0,
    };

    insertMessage.run(message);
    io.emit('chat:message', message);
  });

  socket.on('chat:reaction', (payload) => {
    const messageId = typeof payload?.messageId === 'string' ? payload.messageId.trim() : '';
    const reaction = payload?.reaction === 'like' ? 1 : payload?.reaction === 'dislike' ? -1 : 0;

    if (!messageId || !reaction) {
      return;
    }

    const message = db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId);
    if (!message) {
      return;
    }

    const existingReaction = getUserReaction.get(messageId, socket.user.id);

    // Fetch current counts to enforce caps
    const currentCounts = getMessageReactionCounts(messageId);
    const MAX_REACTIONS = 100;

    // If user is removing their existing reaction, allow it.
    if (existingReaction && existingReaction.reaction === reaction) {
      deleteMessageReaction.run(messageId, socket.user.id);
      const updated = getMessageReactionCounts(messageId);
      io.emit('chat:reaction', { ...updated, messageId, userId: socket.user.id });
      return;
    }

    // If adding a like would exceed the cap, deny the action and emit current counts back
    if (reaction === 1) {
      if (currentCounts.likes >= MAX_REACTIONS) {
        socket.emit('chat:reaction', { ...currentCounts, messageId, userId: socket.user.id });
        return;
      }
    }

    // If adding a dislike would exceed the cap, deny the action and emit current counts back
    if (reaction === -1) {
      if (currentCounts.dislikes >= MAX_REACTIONS) {
        socket.emit('chat:reaction', { ...currentCounts, messageId, userId: socket.user.id });
        return;
      }
    }

    // Proceed to upsert (insert or switch reaction)
    const now = new Date().toISOString();
    upsertMessageReaction.run({
      messageId,
      userId: socket.user.id,
      reaction,
      createdAt: now,
      updatedAt: now,
    });

    const updated = getMessageReactionCounts(messageId);
    io.emit('chat:reaction', { ...updated, messageId, userId: socket.user.id });
  });
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

// server.listen(port, () => {
//   console.log(`Chat app running at http://localhost:${port}`);
// });

if (HTTPS_CONFIG) {
  const httpsOptions = {
    cert: fs.readFileSync(HTTPS_CONFIG.cert),
    key: fs.readFileSync(HTTPS_CONFIG.key)
  };
  
  https.createServer(httpsOptions, app).listen(HTTPS_CONFIG.port, () => {
    console.log(`Timetable app running on https://localhost:${HTTPS_CONFIG.port}`);
  }).on("error", (err) => {
    console.error("HTTPS server failed to start:", err.message);
  });
} else {
  server.listen(PORT, () => {
    console.log(`Timetable app running on http://localhost:${PORT}`);
  }).on("error", (err) => {
    console.error("Server failed to start:", err.message);
  });
}