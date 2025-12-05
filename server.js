const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 服务器唯一实例 ID ---
const SERVER_ID = Date.now().toString();

// --- 汉字库配置 ---
const TILES_CONFIG = {
    wildcard: "❀",
    chars: [
        // --- 原有基础字库 (已清理) ---
        "我", "你", "他", "她", "它", "谁", "人", "鬼", "神", "狗", "猫", "爸", "妈", "爷", "奶", "老", "板",
        "爱", "恨", "打", "吃", "喝", "睡", "玩", "杀", "救", "亲", "抱", "跑", "飞", "哭", "笑", "怕", "赢", "输", "是", "有", "无", "想", "要", "给", "抢", "看", "摸", "舔", "闻", "踩",
        "钱", "屁", "饭", "酒", "烟", "车", "房", "命", "运", "气", "脸", "脑", "心", "胆", "天", "地", "水", "火", "梦", "话", "家", "国", "球", "肉", "血", "洞", "光", "床",
        "大", "小", "多", "少", "好", "坏", "美", "丑", "浪", "纯", "笨", "强", "弱", "快", "慢", "爽", "痛", "难",
        "的", "了", "吗", "呢", "吧", "啊", "不", "别", "很", "太", "更", "最", "被", "把", "让", "只", "又", "也",
        "哈", "嘿", "嘻", "哼", "靠", "滚", "变", "态", "一", "二", "三", "万", "亿",
        
        // --- 新增文档中的字 ---
        "们", "这", "那", "啥", "都", "每", "友", "朋", "女", "忙", "闲", "走", "跳", "听", "说", "坐", "早", "晚", "今", "昨", 
        "明", "前", "后", "里", "外", "如", "完", "春", "夏", "秋", "冬", "像", "喜", "怒", "哀", "乐", "愁", "点", "醉", "甜", 
        "热", "冷", "白", "惊", "眼", "烦", "风", "花", "日", "男", "为", "海", "到", "长", "短", "高", "低", "中", "深", "浅", 
        "过", "见", "上", "哦", "嗯", "就", "饿", "个", "道", "问", "真", "假", "发", "生", "意", "情", "向", "掉", "书", 
        "画", "活", "死", "得", "着", "将", "和", "或", "且"
    ]
};
// 去重
TILES_CONFIG.chars = [...new Set(TILES_CONFIG.chars)];

let gameState = {
    status: 'LOBBY', 
    players: [],     
    deck: [],
    discardPile: [],
    settings: { playerCount: 4 }, 
    round: {
        wind: 0,
        dealerIndex: 0,
        turnIndex: 0,
        winners: [],
        canEat: false
    },
    voting: {
        pitcherId: null,
        pitcherHand: [],
        votes: {}
    }
};

function generateDeck() {
    let deck = [];
    for(let i=0; i<8; i++) deck.push(TILES_CONFIG.wildcard);
    deck = deck.concat(TILES_CONFIG.chars);
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function nextTurn(allowEat = true) {
    let nextIndex = (gameState.round.turnIndex + 1) % gameState.players.length;
    while (gameState.players[nextIndex].hasWon) {
        nextIndex = (nextIndex + 1) % gameState.players.length;
    }
    gameState.round.turnIndex = nextIndex;
    gameState.round.canEat = allowEat && gameState.discardPile.length > 0;

    const player = gameState.players[nextIndex];
    io.emit('updateGame', getPublicState());
    io.emit('flashMessage', `轮到 ${player.name}`);
    io.to(player.id).emit('turnWaitAction', { 
        canEat: gameState.round.canEat, 
        lastDiscard: gameState.discardPile[gameState.discardPile.length - 1] 
    });
}

function getPublicState() {
    return {
        status: gameState.status,
        players: gameState.players.map(p => ({
            id: p.id,
            uid: p.uid, 
            name: p.name,
            score: p.score,
            handCount: p.hand.length,
            isDealer: p.isDealer,
            hasWon: p.hasWon,
            isTurn: gameState.status === 'PLAYING' && gameState.players.indexOf(p) === gameState.round.turnIndex,
            history: p.history 
        })),
        roundInfo: {
            text: `东风场 第 ${gameState.round.wind + 1} 局`,
            deckCount: gameState.deck.length
        },
        discardPile: gameState.discardPile,
        voting: gameState.voting,
        settings: gameState.settings 
    };
}

function startRound(isRenchan) {
    gameState.status = 'PLAYING';
    gameState.deck = generateDeck();
    gameState.discardPile = [];
    gameState.round.winners = [];
    
    gameState.players.forEach((p, idx) => {
        p.hand = gameState.deck.splice(0, 13);
        p.hasWon = false;
        if (idx === gameState.round.dealerIndex) {
            gameState.round.turnIndex = idx;
            const tile = gameState.deck.pop();
            p.hand.push(tile);
            gameState.round.canEat = false; 
        }
    });
    io.emit('gameStart', { round: gameState.round.wind + 1 });
    gameState.players.forEach(p => {
        let lastIndex = -1;
        if(gameState.players.indexOf(p) === gameState.round.dealerIndex) lastIndex = p.hand.length - 1;
        io.to(p.id).emit('handUpdate', { hand: p.hand, newTileIndex: lastIndex });
    });
    io.emit('updateGame', getPublicState());
    io.emit('flashMessage', `第 ${gameState.round.wind + 1} 局开始！`);
}

function endRound(isDraw) {
    let dealerIndex = gameState.round.dealerIndex;
    let dealer = gameState.players[dealerIndex];
    let isRenchan = !isDraw && dealer.hasWon;

    if (isRenchan) io.emit('flashMessage', `庄家连庄！`);
    else {
        io.emit('flashMessage', `庄家轮换`);
        gameState.round.wind++; 
        gameState.round.dealerIndex = (dealerIndex + 1) % gameState.players.length; 
        gameState.players.forEach((p, i) => p.isDealer = (i === gameState.round.dealerIndex));
    }

    if (gameState.round.wind >= 4) {
        gameState.status = 'END';
        io.emit('updateGame', getPublicState());
    } else {
        setTimeout(() => { startRound(isRenchan); }, 4000);
    }
}

io.on('connection', (socket) => {
    
    socket.emit('welcome', { serverId: SERVER_ID });
    
    socket.on('join', ({ name, uid }) => {
        const existingPlayer = gameState.players.find(p => p.uid === uid);

        if (existingPlayer) {
            console.log(`Player ${name} reconnected.`);
            existingPlayer.id = socket.id; 
            if (name) existingPlayer.name = name;
            socket.emit('joined', { id: socket.id });

            if (gameState.status !== 'LOBBY') {
                socket.emit('gameStart', { round: gameState.round.wind + 1 });
                socket.emit('handUpdate', { hand: existingPlayer.hand, newTileIndex: -1 });
                
                const pIndex = gameState.players.indexOf(existingPlayer);
                if (gameState.status === 'PLAYING' && gameState.round.turnIndex === pIndex && !existingPlayer.hasWon) {
                    socket.emit('turnWaitAction', { 
                        canEat: gameState.round.canEat, 
                        lastDiscard: gameState.discardPile[gameState.discardPile.length - 1] 
                    });
                }
                if (gameState.status === 'VOTING') socket.emit('startVoting', gameState.voting);
            } else if (gameState.status === 'END') {
                io.emit('updateGame', getPublicState());
            }
        } else {
            if (gameState.status !== 'LOBBY') {
                socket.emit('msg', '游戏已在进行中，无法加入');
                return;
            }
            if (gameState.players.length >= 4) {
                socket.emit('msg', '房间已满');
                return;
            }
            
            const newPlayer = {
                id: socket.id,
                uid: uid, 
                name: name || `玩家${gameState.players.length+1}`,
                hand: [],
                score: 0,
                isReady: false,
                hasWon: false,
                isDealer: false,
                history: []
            };
            gameState.players.push(newPlayer);
            socket.emit('joined', { id: socket.id });
        }
        io.emit('updateGame', getPublicState());
    });

    socket.on('setPlayerCount', (n) => { 
        gameState.settings.playerCount = n; 
        io.emit('settingsUpdate', gameState.settings);
    });

    socket.on('ready', () => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (p) p.isReady = true;
        io.emit('updateGame', getPublicState());
        const readyCount = gameState.players.filter(pl => pl.isReady).length;
        if (readyCount === gameState.settings.playerCount && readyCount >= 2) {
            gameState.round.wind = 0;
            const randDealer = Math.floor(Math.random() * readyCount);
            gameState.round.dealerIndex = randDealer;
            gameState.players.forEach((pl, i) => pl.isDealer = (i === randDealer));
            startRound(false);
        }
    });

    socket.on('playerAction', (actionType) => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p || gameState.status !== 'PLAYING' || gameState.players.indexOf(p) !== gameState.round.turnIndex) return;

        if (actionType === 'eat') {
            if (gameState.discardPile.length === 0) return;
            const eatenTile = gameState.discardPile.pop();
            p.hand.push(eatenTile);
            io.emit('msg', `${p.name} 吃掉了 [${eatenTile}]`);
            io.to(p.id).emit('handUpdate', { hand: p.hand, newTileIndex: p.hand.length - 1 });
            io.emit('updateGame', getPublicState());
        } else {
            if (gameState.deck.length > 0) {
                const tile = gameState.deck.pop();
                p.hand.push(tile);
                io.emit('msg', `${p.name} 摸牌`);
                io.to(p.id).emit('handUpdate', { hand: p.hand, newTileIndex: p.hand.length - 1 });
                io.emit('updateGame', getPublicState());
            } else {
                endRound(true);
            }
        }
    });

    // 处理手牌排序同步
    socket.on('reorder', (newHand) => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p) return;
        
        // 防作弊校验
        const currentSorted = [...p.hand].sort().join('');
        const newSorted = [...newHand].sort().join('');
        
        if (currentSorted === newSorted) {
            p.hand = newHand; // 更新服务器端手牌
        } else {
            socket.emit('handUpdate', { hand: p.hand, newTileIndex: -1 });
        }
    });

    socket.on('discard', (tileIndex) => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p || gameState.status !== 'PLAYING' || gameState.players.indexOf(p) !== gameState.round.turnIndex) return;
        if (tileIndex < 0 || tileIndex >= p.hand.length) return;
        const tile = p.hand.splice(tileIndex, 1)[0];
        gameState.discardPile.push(tile);
        io.emit('msg', `${p.name} 打出 [${tile}]`);
        io.to(p.id).emit('handUpdate', { hand: p.hand, newTileIndex: -1 });
        nextTurn(true);
    });

    socket.on('pitch', (data) => {
        const p = gameState.players.find(pl => pl.id === socket.id);
        if (!p || gameState.status !== 'PLAYING' || p.hasWon) return;
        if (data.hand && data.hand.length === p.hand.length) p.hand = data.hand; 
        gameState.status = 'VOTING';
        gameState.voting = { pitcherId: socket.id, pitcherName: p.name, pitcherHand: p.hand, votes: {} };
        io.emit('startVoting', gameState.voting);
    });

    socket.on('submitVote', (score) => {
        if (gameState.status !== 'VOTING') return;
        if (socket.id === gameState.voting.pitcherId) return;
        gameState.voting.votes[socket.id] = parseInt(score);
        if (Object.keys(gameState.voting.votes).length >= gameState.players.length - 1) resolveVoting();
    });
});

function resolveVoting() {
    const votes = Object.values(gameState.voting.votes);
    const totalVotes = votes.reduce((a, b) => a + b, 0);
    const pitcher = gameState.players.find(p => p.id === gameState.voting.pitcherId);
    const threshold = (gameState.players.length - 1) * 5;
    const isPass = totalVotes > threshold;
    let msg = "";
    if (isPass) {
        pitcher.hasWon = true;
        pitcher.history.push([...gameState.voting.pitcherHand]); 
        gameState.round.winners.push(pitcher.id);
        const rank = gameState.round.winners.length;
        let baseScore = rank === 1 ? 20 : (rank === 2 ? 10 : 5);
        let finalScore = baseScore + Math.floor(totalVotes * 0.5);
        if (pitcher.isDealer) { finalScore = Math.ceil(finalScore * 1.5); msg += ` [庄家]`; }
        pitcher.score += finalScore;
        msg = `${pitcher.name} 胡牌! 得分${finalScore} (票数${totalVotes})`;
        io.emit('voteResult', { success: true, message: msg });
        io.emit('flashMessage', msg);
        if (gameState.round.winners.length >= gameState.players.length - 1) {
            io.emit('updateGame', getPublicState());
            setTimeout(() => endRound(false), 3000);
            return;
        } 
        gameState.status = 'PLAYING';
        if (gameState.players[gameState.round.turnIndex].id === pitcher.id) nextTurn(false); 
        else io.emit('updateGame', getPublicState());
    } else {
        pitcher.score -= 5;
        msg = `路演失败 (票${totalVotes}/${threshold}) 扣5分`;
        io.emit('voteResult', { success: false, message: msg }); 
        io.emit('flashMessage', msg);
        gameState.status = 'PLAYING';
        io.emit('updateGame', getPublicState());
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

