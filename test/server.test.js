const { expect } = require('chai');
const io = require('socket.io-client');
const port = 3001;
const socketUrl = `http://localhost:${port}`;

// We need to require the server file, but since it starts listening automatically,
// we might want to refactor server.js to export the app/server or just run it as a child process.
// Or we can just run the test against the running server if we can start/stop it.
// However, server.js listens on PORT or 3000.
// Let's modify server.js to allow testing or just spawn it.

// Actually, `server.js` does `server.listen(PORT, ...)`.
// If I require it, it will try to listen on port 3000 (or env).
// It's better to spawn it or modify it to export the server instance.

// For now, I'll rely on the fact that I can start it in a separate process or
// modify server.js to only listen if not in test mode.
// But simplest way for this environment:
// I will create a child process for the server in the test setup.

const { spawn } = require('child_process');

describe('Anonymous Chat Server', function() {
  this.timeout(10000);
  let serverProcess;
  let roomId;
  let hostToken;

  before((done) => {
    // Start the server
    serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: port }
    });

    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('Server running')) {
        done();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(data.toString());
    });
  });

  after(() => {
    if (serverProcess) serverProcess.kill();
  });

  async function createRoom() {
    const res = await fetch(`${socketUrl}/create-room`);
    const data = await res.json();
    return data;
  }

  it('should create a room', async () => {
    const { roomId, hostToken } = await createRoom();
    expect(roomId).to.be.a('string');
    expect(hostToken).to.be.a('string');
  });

  it('should join a room and exchange messages', function(done) {
    createRoom().then(({ roomId }) => {
      const client1 = io(socketUrl);
      const client2 = io(socketUrl);
      const username1 = 'User1';
      const username2 = 'User2';

      client1.on('connect', () => {
        client1.emit('join-room', { roomId, username: username1 }, (resp) => {
          expect(resp.ok).to.be.true;
        });
      });

      client2.on('connect', () => {
        client2.emit('join-room', { roomId, username: username2 }, (resp) => {
          expect(resp.ok).to.be.true;
        });
      });

      let msgsReceived = 0;
      const checkDone = () => {
        msgsReceived++;
        if (msgsReceived === 2) {
          client1.disconnect();
          client2.disconnect();
          done();
        }
      };

      client1.on('message', (msg) => {
        if (msg.text === 'Hello from User2') {
          expect(msg.from).to.equal(username2);
          checkDone();
        }
      });

      client2.on('message', (msg) => {
        if (msg.text === 'Hello from User2') {
          expect(msg.from).to.equal(username2);
          checkDone();
        }
      });

      // Wait a bit for both to join
      setTimeout(() => {
        client2.emit('message', 'Hello from User2');
      }, 500);
    });
  });

  it('should handle double escaping correctly (client handles escaping)', (done) => {
    createRoom().then(({ roomId }) => {
      const client = io(socketUrl);
      const username = '<bold>User</bold>';
      const message = '<script>alert(1)</script>';

      client.on('connect', () => {
        client.emit('join-room', { roomId, username }, (resp) => {
          expect(resp.ok).to.be.true;

          // Listen for message
          client.on('message', (msg) => {
            // Server should NOT escape it anymore
            expect(msg.text).to.equal(message);
            expect(msg.from).to.equal(username.slice(0, 32));
            client.disconnect();
            done();
          });

          client.emit('message', message);
        });
      });
    });
  });

  it('should cleanup room when host closes it', (done) => {
    createRoom().then(({ roomId, hostToken }) => {
      const client = io(socketUrl);
      client.on('connect', () => {
          client.emit('close-room', { roomId, hostToken }, (resp) => {
              expect(resp.ok).to.be.true;
              // Verify room is gone
              fetch(`${socketUrl}/room-info/${roomId}`)
                  .then(r => {
                      expect(r.status).to.equal(404);
                      client.disconnect();
                      done();
                  });
          });
      });
    });
  });

  it('should broadcast typing events', (done) => {
    createRoom().then(({ roomId }) => {
      const client1 = io(socketUrl);
      const client2 = io(socketUrl);
      const username1 = 'TypingUser';
      const username2 = 'Observer';
      let typingReceived = false;

      client1.on('connect', () => {
        client1.emit('join-room', { roomId, username: username1 });
      });

      client2.on('connect', () => {
        client2.emit('join-room', { roomId, username: username2 });
      });

      client2.on('typing', (data) => {
        if (data.username === username1) {
          typingReceived = true;
          // After typing, send stop typing
          client1.emit('stop-typing');
        }
      });

      client2.on('stop-typing', (data) => {
        if (data.username === username1 && typingReceived) {
          client1.disconnect();
          client2.disconnect();
          done();
        }
      });

      // trigger typing after a short delay
      setTimeout(() => {
        client1.emit('typing');
      }, 500);
    });
  });

  it('should enforce message rate limiting', function(done) {
    this.timeout(5000);
    createRoom().then(({ roomId }) => {
      const client = io(socketUrl);
      const username = 'Spammer';

      client.on('connect', () => {
        client.emit('join-room', { roomId, username }, async () => {
          // Send 10 messages quickly (allowed)
          const promises = [];
          for (let i = 0; i < 10; i++) {
            promises.push(new Promise(resolve => {
              client.emit('message', `msg ${i}`, (ack) => {
                expect(ack.ok).to.be.true;
                resolve();
              });
            }));
          }
          await Promise.all(promises);

          // Send 11th message (should fail)
          client.emit('message', 'limit breaker', (ack) => {
            expect(ack.ok).to.be.false;
            expect(ack.error).to.contain('Rate limit');
            client.disconnect();
            done();
          });
        });
      });
    });
  });

});
