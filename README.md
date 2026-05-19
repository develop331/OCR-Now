# OCR-Now

Minimal real-time chat app boilerplate.

## Run it

1. Install dependencies with `npm install`.
2. Start the server with `npm start`.
3. Open `http://localhost:3000` in one or more browser windows.

## What it does

- Lets users sign up and log in with a username and password.
- Requires signups to be 14 years or older.
- Sends messages between connected clients in real time.
- Saves messages in a local SQLite database named `messages.db`.
- Shows the most recent 100 saved messages when a client connects.
- Uses the logged-in username for chat messages.