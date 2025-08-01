import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const PORT = process.env.PORT || 3000;

interface Client {
  id: string;
  ws: any;
  room?: string;
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Set<string>>();

const server = createServer((req, res) => {
  let filePath = join(__dirname, '..', 'public', req.url === '/' ? 'index.html' : req.url!);

  try {
    const content = readFileSync(filePath);
    const ext = filePath.split('.').pop();
    const contentType =
      ext === 'js'
        ? 'application/javascript'
        : ext === 'css'
          ? 'text/css'
          : ext === 'html'
            ? 'text/html'
            : 'text/plain';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(7);
  const client: Client = { id: clientId, ws };
  clients.set(clientId, client);

  console.log(`Client ${clientId} connected`);

  ws.send(JSON.stringify({ type: 'id', id: clientId }));

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'join':
          handleJoinRoom(client, message.room);
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(client, message);
          break;

        case 'leave':
          handleLeaveRoom(client);
          break;
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`Client ${clientId} disconnected`);
    handleLeaveRoom(client);
    clients.delete(clientId);
  });
});

function handleJoinRoom(client: Client, roomId: string) {
  if (client.room) {
    handleLeaveRoom(client);
  }

  client.room = roomId;

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId)!;
  const otherClients = Array.from(room);

  room.add(client.id);

  client.ws.send(
    JSON.stringify({
      type: 'room-joined',
      room: roomId,
      others: otherClients,
    })
  );

  otherClients.forEach((otherId) => {
    const other = clients.get(otherId);
    if (other) {
      other.ws.send(
        JSON.stringify({
          type: 'new-peer',
          peerId: client.id,
        })
      );
    }
  });
}

function handleSignaling(client: Client, message: any) {
  if (!client.room || !message.to) return;

  const target = clients.get(message.to);
  if (target && target.room === client.room) {
    target.ws.send(
      JSON.stringify({
        ...message,
        from: client.id,
      })
    );
  }
}

function handleLeaveRoom(client: Client) {
  if (!client.room) return;

  const room = rooms.get(client.room);
  if (room) {
    room.delete(client.id);

    if (room.size === 0) {
      rooms.delete(client.room);
    } else {
      room.forEach((otherId) => {
        const other = clients.get(otherId);
        if (other) {
          other.ws.send(
            JSON.stringify({
              type: 'peer-left',
              peerId: client.id,
            })
          );
        }
      });
    }
  }

  client.room = undefined;
}

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
