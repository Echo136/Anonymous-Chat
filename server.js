// server.js
const express = require('express');
const http = require('http');
const { nanoid } = require('nanoid');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { pingTimeout: 20000 });

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// In-memory rooms
// rooms[roomId] = { hostToken, hostSocketId, users: Map<socketId, {username}>, createdAt }
const rooms = {};

// Create a room
app.get('/create-room', (req, res) => {
  const roomId = nanoid(8);
  const hostToken = nanoid(16);
  rooms[roomId] = {
    hostToken,
    hostSocketId: null,
    users: new Map(),
    createdAt: Date.now()
  };
  res.json({ roomId, inviteLink: `/chat.html?room=${roomId}`, hostToken });
});

// Room info (non-sensitive)
app.get('/room-info/:roomId', (req, res) => {
  const r = rooms[req.params.roomId];
  if (!r) return res.status(404).json({ error: 'Not found' });
  return res.json({ userCount: r.users.size, createdAt: r.createdAt });
});

// Helper to escape HTML (server-side sanitization)
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

io.on('connection', socket => {
  // join-room: { roomId, username, hostToken? }
  socket.on('join-room', (payload, ack) => {
    try {
      const { roomId, username, hostToken } = payload || {};
      if (!roomId || !username) {
        return ack?.({ ok: false, error: 'Missing roomId or username' });
      }
      const room = rooms[roomId];
      if (!room) return ack?.({ ok: false, error: 'Room not found or closed' });

      // enforce max 5
      if (room.users.size >= 5) {
        return ack?.({ ok: false, error: 'Room full (max 5)' });
      }

      // set host if token matches
      if (hostToken && hostToken === room.hostToken) {
        room.hostSocketId = socket.id;
        socket.data.isHost = true;
        socket.data.hostToken = hostToken;
      }

      const safeName = escapeHtml(String(username).slice(0, 32));
      room.users.set(socket.id, { username: safeName });
      socket.data.roomId = roomId;
      socket.data.username = safeName;

      socket.join(roomId);

      io.to(roomId).emit('system', { type: 'join', username: safeName });
      io.to(roomId).emit('participants', Array.from(room.users.values()).map(u => u.username));

      ack?.({ ok: true, roomId, userCount: room.users.size, host: !!socket.data.isHost });
    } catch (err) {
      console.error('join-room error', err);
      ack?.({ ok: false, error: 'Server error' });
    }
  });

  // message: text string
  socket.on('message', (msg, ack) => {
    const { roomId, username } = socket.data;
    if (!roomId || !rooms[roomId]) return ack?.({ ok: false, error: 'Not in room' });

    const text = String(msg || '').slice(0, 1000);
    const safeText = escapeHtml(text);
    io.to(roomId).emit('message', { from: username, text: safeText, ts: Date.now() });
    ack?.({ ok: true });
  });

  // close-room: { roomId, hostToken }
  socket.on('close-room', (payload, ack) => {
    const { roomId, hostToken } = payload || {};
    const room = rooms[roomId];
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (hostToken !== room.hostToken) return ack?.({ ok: false, error: 'Invalid host token' });

    // notify and disconnect sockets
    io.to(roomId).emit('system', { type: 'room-closed' });
    const sockets = Array.from(room.users.keys());
    sockets.forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        try {
          s.leave(roomId);
          s.disconnect(true);
        } catch (e) { /* ignore */ }
      }
    });

    // delete room data
    delete rooms[roomId];
    return ack?.({ ok: true });
  });

  // disconnect cleanup
  socket.on('disconnect', reason => {
    const { roomId, username } = socket.data || {};
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    room.users.delete(socket.id);

    if (room.hostSocketId === socket.id) {
      room.hostSocketId = null;
    }

    io.to(roomId).emit('system', { type: 'leave', username });
    io.to(roomId).emit('participants', Array.from(room.users.values()).map(u => u.username));

    // if empty, delete room immediately
    if (room.users.size === 0) {
      delete rooms[roomId];
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
