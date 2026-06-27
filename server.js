/**
 * 루미큐브 PLUS 멀티플레이어 매칭용 고성능 Socket 서버 인프라 로직
 * 구동 명령어: npm install express socket.io && node server.js
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

// 실시간 접속 유저 리스트 구조 데이터 저장소
let onlineUsers = {}; 

const AVATARS = ['grand_father', 'grand_mother', 'boy', 'woman'];

// 동기화 공유 덱 제너레이터 함수
function generateServerDeck() {
  const colors = ['red','blue','yellow','black'];
  let deck = [];
  let seq = 1;
  for(const color of colors){
    for(let n=1; n<=13; n++){
      deck.push({id:'t'+(seq++), number:n, color, isJoker:false});
      deck.push({id:'t'+(seq++), number:n, color, isJoker:false});
    }
  }
  for(let i=0; i<2; i++){
    deck.push({id:'t'+(seq++), number:0, color:'joker', isJoker:true});
  }
  for(let i=deck.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

io.on('connection', (socket) => {

  socket.on('joinLobby', (data) => {
    onlineUsers[socket.id] = {
      id: socket.id,
      nickname: data.nickname,
      avatar: data.avatar,
      room: null,
      status: 'waiting' // 매칭 전 대기 상태
    };
    io.emit('updateUserList', Object.values(onlineUsers));
  });

  socket.on('requestMatch', (data) => {
    const challenger = onlineUsers[socket.id];
    if (challenger) {
      io.to(data.targetId).emit('matchRequested', {
        fromId: socket.id,
        fromNickname: challenger.nickname
      });
    }
  });

  socket.on('matchResponse', (data) => {
    if (data.accepted) {
      const p1 = onlineUsers[data.targetId];
      const p2 = onlineUsers[socket.id];
      
      if (!p1 || !p2) return;

      const roomId = `room_${data.targetId}_${socket.id}`;
      p1.room = roomId;
      p2.room = roomId;
      p1.status = 'playing'; // 대결 수락 시 게임 중 상태로 즉각 전환
      p2.status = 'playing';

      io.emit('updateUserList', Object.values(onlineUsers));

      const maxPlayers = data.roomOptions.numPlayers;
      let roomPlayers = [];

      roomPlayers.push({ id: 'p0', type: 'human', networkId: p1.id, avatar: p1.avatar, name: p1.nickname, rack: [], melded: false, score: 0, tipUses: (p1.avatar=='grand_mother'?4:3) });
      roomPlayers.push({ id: 'p1', type: 'human', networkId: p2.id, avatar: p2.avatar, name: p2.nickname, rack: [], melded: false, score: 0, tipUses: (p2.avatar=='grand_mother'?4:3) });

      for (let i = 2; i < maxPlayers; i++) {
        const randomAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
        roomPlayers.push({
          id: `p${i}`,
          type: 'ai',
          networkId: null,
          avatar: randomAvatar,
          name: `AI 봇_${i}`,
          rack: [],
          melded: false,
          score: 0,
          tipUses: 0
        });
      }

      const syncDeck = generateServerDeck();
      roomPlayers.forEach(p => {
        p.rack = syncDeck.splice(0, 14);
      });

      io.to(p1.id).emit('gameStartSync', { roomPlayers, options: data.roomOptions, deck: syncDeck });
      io.to(p2.id).emit('gameStartSync', { roomPlayers, options: data.roomOptions, deck: syncDeck });
    } else {
      io.to(data.targetId).emit('matchRejected', { nickname: onlineUsers[socket.id]?.nickname });
    }
  });

  socket.on('playerMove', (gameState) => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      socket.to(user.room).emit('syncMove', gameState);
    }
  });

  // 온라인 대전 채팅 메시지 같은 방의 상대에게 중계
  socket.on('chatMessage', (data) => {
    const user = onlineUsers[socket.id];
    if (user && user.room && data && typeof data.text === 'string') {
      const text = data.text.slice(0, 200);
      socket.to(user.room).emit('chatMessage', { nickname: user.nickname, text });
    }
  });

  // 게임 정상 종료 시 양쪽 유저의 상태값을 대기로 롤백
  socket.on('gameEnded', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      const targetRoom = user.room;
      for(let key in onlineUsers) {
         if(onlineUsers[key].room === targetRoom) {
             onlineUsers[key].status = 'waiting';
             onlineUsers[key].room = null;
         }
      }
      io.emit('updateUserList', Object.values(onlineUsers));
    }
  });

  socket.on('surrender', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      const targetRoom = user.room;
      socket.to(targetRoom).emit('surrenderNotice', { nickname: user.nickname });
      
      // 기권한 사람 포함 속한 방 멤버 상태 롤백 동기화
      for(let key in onlineUsers) {
         if(onlineUsers[key].room === targetRoom) {
             onlineUsers[key].status = 'waiting';
             onlineUsers[key].room = null;
         }
      }
      io.emit('updateUserList', Object.values(onlineUsers));
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      const targetRoom = user.room;
      socket.to(targetRoom).emit('surrenderNotice', { nickname: user.nickname });
      for(let key in onlineUsers) {
         if(onlineUsers[key].room === targetRoom) {
             onlineUsers[key].status = 'waiting';
             onlineUsers[key].room = null;
         }
      }
    }
    delete onlineUsers[socket.id];
    io.emit('updateUserList', Object.values(onlineUsers));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Rummikub Server] 구동 성공 -> http://localhost:${PORT}`);
});