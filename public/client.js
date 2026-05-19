const messagesElement = document.getElementById('messages');
const composerElement = document.getElementById('composer');
const messageInput = document.getElementById('message');
const imageInput = document.getElementById('image-input');
const imageLabel = document.getElementById('image-label');
const authPanel = document.getElementById('auth-panel');
const chatPanel = document.getElementById('chat-panel');
const authErrorElement = document.getElementById('auth-error');
const signupForm = document.getElementById('signup-form');
const loginForm = document.getElementById('login-form');
const logoutButton = document.getElementById('logout-button');
const welcomeText = document.getElementById('welcome-text');

const signupUsernameInput = document.getElementById('signup-username');
const signupPasswordInput = document.getElementById('signup-password');
const signupAgeInput = document.getElementById('signup-age');
const loginUsernameInput = document.getElementById('login-username');
const loginPasswordInput = document.getElementById('login-password');
const modal = document.getElementById('modal');
const modalMessage = document.getElementById('modal-message');
const modalClose = document.getElementById('modal-close');

let socket = null;
let currentUser = null;
const userReactions = new Map();
let pendingImageFilename = null;

function showError(message) {
  authErrorElement.textContent = message || '';
}

function showModal(message) {
  if (!message) {
    return;
  }

  modalMessage.textContent = message;
  modal.classList.remove('hidden');
}

function hideModal() {
  modal.classList.add('hidden');
  modalMessage.textContent = '';
}

function showChat(user) {
  currentUser = user;
  welcomeText.textContent = `Signed in as ${user.username}`;
  authPanel.classList.add('hidden');
  chatPanel.classList.remove('hidden');
}

function showAuth() {
  currentUser = null;
  authPanel.classList.remove('hidden');
  chatPanel.classList.add('hidden');
  welcomeText.textContent = '';
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io();

  socket.on('chat:history', (history) => {
    messagesElement.innerHTML = '';
    history.forEach((message) => appendMessage(message));
    scrollToBottom();
  });

  socket.on('chat:message', (message) => {
    appendMessage(message);
  });

  socket.on('chat:reaction', (reactionUpdate) => {
    recordUserReaction(reactionUpdate);
    updateMessageReactions(reactionUpdate);
  });

  socket.on('auth:required', () => {
    showAuth();
  });
}

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function scrollToBottom() {
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function appendMessage(message) {
  const item = document.createElement('li');
  item.className = 'message';
  item.dataset.messageId = message.id;
  item.style.cursor = 'pointer';

  if (currentUser && message.userId === currentUser.id) {
    item.classList.add('self');
  }

  item.addEventListener('click', () => {
    window.location.href = `/post/${message.id}`;
  });

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const author = document.createElement('strong');
  author.textContent = message.username;

  const timestamp = document.createElement('span');
  timestamp.textContent = formatTimestamp(message.timestamp);

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text;

  const reactions = document.createElement('div');
  reactions.className = 'message-reactions';

  const userReaction = userReactions.get(message.id);

  const likeButton = document.createElement('button');
  likeButton.type = 'button';
  likeButton.className = 'reaction-button like-button';
  if (userReaction === 'like') likeButton.classList.add('selected');
  likeButton.dataset.reaction = 'like';
  likeButton.textContent = `Like (${message.likes || 0})`;
  likeButton.addEventListener('click', () => sendReaction(message.id, 'like'));

  const dislikeButton = document.createElement('button');
  dislikeButton.type = 'button';
  dislikeButton.className = 'reaction-button dislike-button';
  if (userReaction === 'dislike') dislikeButton.classList.add('selected');
  dislikeButton.dataset.reaction = 'dislike';
  dislikeButton.textContent = `Dislike (${message.dislikes || 0})`;
  dislikeButton.addEventListener('click', () => sendReaction(message.id, 'dislike'));

  reactions.append(likeButton, dislikeButton);

  meta.append(author, timestamp);
  item.append(meta, text);
  
  if (message.imageFilename) {
    const img = document.createElement('img');
    img.className = 'message-image';
    img.src = `/uploads/${message.imageFilename}`;
    img.alt = 'Message image';
    item.appendChild(img);
  }
  
  item.append(reactions);
  messagesElement.appendChild(item);
  scrollToBottom();
}

function recordUserReaction(reactionUpdate) {
  if (reactionUpdate.userId === currentUser?.id) {
    const messageId = reactionUpdate.messageId;
    if (userReactions.get(messageId) === (reactionUpdate.reaction === 1 ? 'like' : reactionUpdate.reaction === -1 ? 'dislike' : null)) {
      userReactions.delete(messageId);
    } else if (reactionUpdate.reaction) {
      userReactions.set(messageId, reactionUpdate.reaction === 1 ? 'like' : 'dislike');
    }
  }
}

function updateMessageReactions(reactionUpdate) {
  const item = messagesElement.querySelector(`[data-message-id="${CSS.escape(reactionUpdate.messageId)}"]`);

  if (!item) {
    return;
  }

  const likeButton = item.querySelector('.like-button');
  const dislikeButton = item.querySelector('.dislike-button');

  if (likeButton) {
    likeButton.textContent = `Like (${reactionUpdate.likes || 0})`;
    if (userReactions.get(reactionUpdate.messageId) === 'like') {
      likeButton.classList.add('selected');
    } else {
      likeButton.classList.remove('selected');
    }
  }

  if (dislikeButton) {
    dislikeButton.textContent = `Dislike (${reactionUpdate.dislikes || 0})`;
    if (userReactions.get(reactionUpdate.messageId) === 'dislike') {
      dislikeButton.classList.add('selected');
    } else {
      dislikeButton.classList.remove('selected');
    }
  }
}

function sendReaction(messageId, reaction) {
  if (!socket || !messageId || !reaction) {
    return;
  }

  socket.emit('chat:reaction', {
    messageId,
    reaction,
  });
}

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 403 && /NSFW|graphic/i.test(payload.error || '')) {
        return { blocked: true };
      }

      throw new Error(payload.error || 'Upload failed');
    }

    return { blocked: false, filename: payload.filename || null };
  } catch (error) {
    console.error('Image upload error:', error);
    return { blocked: false, filename: null };
  }
}

async function apiRequest(url, options) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    ...options,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || '');
  }

  return payload;
}

async function loadCurrentUser() {
  try {
    const response = await fetch('/auth/me', { credentials: 'same-origin' });
    if (!response.ok) {
      showAuth();
      return;
    }

    const data = await response.json();
    if (data.authenticated && data.user) {
      showChat(data.user);
      connectSocket();
      return;
    }

    showAuth();
  } catch {
    showAuth();
  }
}

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  try {
    const data = await apiRequest('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        username: signupUsernameInput.value,
        password: signupPasswordInput.value,
        age: signupAgeInput.value,
      }),
    });

    showModal('signup = True');
    showChat(data.user);
    connectSocket();
  } catch (error) {
    showModal('signup = False');
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  try {
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: loginUsernameInput.value,
        password: loginPasswordInput.value,
      }),
    });

    showModal('login = True');
    showChat(data.user);
    connectSocket();
  } catch (error) {
    showModal('login = False');
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await apiRequest('/auth/logout', {
      method: 'POST',
      body: '{}',
    });

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    messagesElement.innerHTML = '';
    showAuth();
  } catch (error) {
    showError(error.message);
  }
});

composerElement.addEventListener('submit', async (event) => {
  event.preventDefault();

  let text = messageInput.value.trim();
  const imageFile = imageInput.files[0];

  if (!text && !imageFile) {
    return;
  }

  if (!socket) {
    return;
  }

  let imageFilename = null;
  if (imageFile) {
    const uploadResult = await uploadImage(imageFile);

    if (uploadResult?.blocked) {
      text = '<image blocked due to NSFW>';
      messageInput.value = text;
      imageInput.value = '';
      imageLabel.textContent = '';
    } else {
      imageFilename = uploadResult?.filename || null;
    }
  }

  socket.emit('chat:message', {
    text,
    imageFilename,
  });

  messageInput.value = '';
  imageInput.value = '';
  imageLabel.textContent = '';
  messageInput.focus();
});

imageInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) {
    imageLabel.textContent = `📁 ${file.name}`;
  } else {
    imageLabel.textContent = '';
  }
});

loadCurrentUser();

hideModal();

modalClose.addEventListener('click', hideModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) {
    hideModal();
  }
});