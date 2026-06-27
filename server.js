/**
 * 루미큐브 PLUS 멀티플레이어 매칭용 고성능 Socket 서버 인프라 로직
 * 구동 명령어: npm install express socket.io && node server.js
 * v2.0: 서버 권위(Server-Authoritative) 방식으로 턴/타이머 동기화
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

// 방별 게임 상태 저장소 (서버 권위 타이머/턴 관리)
let roomStates = {};

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

// 서버 타이머 시작: 방 단위로 타이머를 관리
function startRoomTimer(roomId, timeLimit) {
  const state = roomStates[roomId];
  if (!state) return;

  // 기존 타이머가 있으면 정리
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  state.timeLeft = timeLimit;

  // 즉시 현재 상태 브로드캐스트
  io.to(roomId).emit('timerTick', {
    timeLeft: state.timeLeft,
    turnIndex: state.turnIndex
  });

  state.timerInterval = setInterval(() => {
    const rs = roomStates[roomId];
    if (!rs) {
      clearInterval(state.timerInterval);
      return;
    }

    rs.timeLeft -= 1;

    // 매 초마다 방 전체에 타이머 상태 브로드캐스트
    io.to(roomId).emit('timerTick', {
      timeLeft: rs.timeLeft,
      turnIndex: rs.turnIndex
    });

    // 시간 초과 시 서버가 강제로 턴 넘김
    if (rs.timeLeft <= 0) {
      clearInterval(rs.timerInterval);
      rs.timerInterval = null;
      io.to(roomId).emit('forceAdvance', { turnIndex: rs.turnIndex });
    }
  }, 1000);
}

io.on('connection', (socket) => {

  socket.on('joinLobby', (data) => {
    onlineUsers[socket.id] = {
      id: socket.id,
      nickname: data.nickname,
      avatar: data.avatar,
      room: null,
      status: 'waiting'
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
      p1.status = 'playing';
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

      const timeLimit = data.roomOptions.timeLimit || 45;

      // 방 게임 상태 초기화 (서버 권위)
      roomStates[roomId] = {
        turnIndex: 0,
        timeLeft: timeLimit,
        timeLimit: timeLimit,
        timerInterval: null,
        players: roomPlayers,
        gameOver: false
      };

      // 두 플레이어를 같은 소켓 룸에 합류
      const p1Socket = io.sockets.sockets.get(p1.id);
      const p2Socket = io.sockets.sockets.get(p2.id);
      if (p1Socket) p1Socket.join(roomId);
      if (p2Socket) p2Socket.join(roomId);

      io.to(p1.id).emit('gameStartSync', { roomPlayers, options: data.roomOptions, deck: syncDeck });
      io.to(p2.id).emit('gameStartSync', { roomPlayers, options: data.roomOptions, deck: syncDeck });

      // 서버 타이머 시작
      setTimeout(() => startRoomTimer(roomId, timeLimit), 500);

    } else {
      io.to(data.targetId).emit('matchRejected', { nickname: onlineUsers[socket.id]?.nickname });
    }
  });

  // 클라이언트가 유효한 턴 종료를 요청
  socket.on('advanceTurn', (gameState) => {
    const user = onlineUsers[socket.id];
    if (!user || !user.room) return;
    const roomId = user.room;
    const rs = roomStates[roomId];
    if (!rs || rs.gameOver) return;

    // 현재 턴의 플레이어인지 검증
    const currentNetworkId = rs.players[rs.turnIndex]?.networkId;
    if (currentNetworkId !== socket.id) return;

    // 턴 진행
    rs.turnIndex = (rs.turnIndex + 1) % rs.players.length;

    // 서버 플레이어 상태 동기화 (rack, melded, score)
    if (gameState && gameState.players) {
      rs.players = gameState.players;
    }

    // 게임 종료 여부 체크
    if (gameState && gameState.gameOver) {
      rs.gameOver = true;
      if (rs.timerInterval) { clearInterval(rs.timerInterval); rs.timerInterval = null; }
      io.to(roomId).emit('syncMove', {
        board: gameState.board,
        players: gameState.players,
        turnIndex: rs.turnIndex,
        gameOver: true
      });
      cleanupRoom(roomId);
      return;
    }

    // 방 전체에 턴 전환 알림 + 전체 게임 상태 동기화
    io.to(roomId).emit('turnChanged', {
      turnIndex: rs.turnIndex,
      board: gameState ? gameState.board : null,
      players: rs.players,
      deck: gameState ? gameState.deck : null
    });

    // 타이머 리셋 (어빌리티 고려는 클라이언트가 표시용으로만 사용, 서버는 기본값)
    startRoomTimer(roomId, rs.timeLimit);
  });

  // 보드/패 변경을 실시간으로 상대에게 중계 (턴 종료가 아닌 드래그 중)
  socket.on('playerMove', (gameState) => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      socket.to(user.room).emit('syncMove', {
        board: gameState.board,
        players: gameState.players,
        turnIndex: gameState.turnIndex
      });
    }
  });

  // 온라인 대전 채팅 메시지 같은 방의 상대에게 중계
  socket.on('chatMessage', (data) => {
    const user = onlineUsers[socket.id];
    if (user && user.room && data && typeof data.text === 'string') {
      const text = data.text.slice(0, 200);
      // 발신자 포함 방 전체에 중계 (자신 제외는 클라이언트에서 처리)
      socket.to(user.room).emit('chatMessage', { nickname: user.nickname, text, senderId: socket.id });
    }
  });

  // 게임 정상 종료 시 양쪽 유저의 상태값을 대기로 롤백
  socket.on('gameEnded', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      cleanupRoom(user.room);
    }
  });

  socket.on('surrender', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      const targetRoom = user.room;
      socket.to(targetRoom).emit('surrenderNotice', { nickname: user.nickname });
      cleanupRoom(targetRoom);
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user && user.room) {
      const targetRoom = user.room;
      socket.to(targetRoom).emit('surrenderNotice', { nickname: user.nickname });
      cleanupRoom(targetRoom);
    }
    delete onlineUsers[socket.id];
    io.emit('updateUserList', Object.values(onlineUsers));
  });
});

function cleanupRoom(roomId) {
  const rs = roomStates[roomId];
  if (rs && rs.timerInterval) {
    clearInterval(rs.timerInterval);
  }
  delete roomStates[roomId];

  for (let key in onlineUsers) {
    if (onlineUsers[key].room === roomId) {
      onlineUsers[key].status = 'waiting';
      onlineUsers[key].room = null;
    }
  }
  io.emit('updateUserList', Object.values(onlineUsers));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Rummikub Server v2.0] 구동 성공 -> http://localhost:${PORT}`);
});