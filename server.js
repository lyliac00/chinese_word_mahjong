const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 游戏配置常量 ---
const TILES_CONFIG = {
    wildcard: "⬜",
    chars: [
        "我", "你", "他", "她", "它", "谁", "人", "鬼", "神", "猪", "狗", "猫", "爸", "妈", "爷", "奶", "老", "板",
        "爱", "恨", "打", "吃", "喝", "睡", "玩", "杀", "救", "亲", "抱", "跑", "飞", "哭", "笑", "怕", "赢", "输", "是", "有", "无", "想", "要", "给", "抢", "看", "摸", "舔", "闻", "踩",
        "钱", "风", "花", "屁", "饭", "酒", "烟", "车", "房", "命", "运", "气", "脸", "脑", "心", "胆", "天", "地", "水", "火", "梦", "话", "家", "国", "球", "肉", "血", "洞", "光", "床",
        "大", "小", "多", "少", "好", "坏", "美", "丑", "雪", "浪", "月", "纯", "笨", "强", "弱", "快", "慢", "爽", "痛", "难",
        "的", "了", "吗", "呢", "吧", "啊", "不", "别", "很", "太", "更", "最", "被", "把", "让", "只", "又", "也",
        "哈", "嘿", "嘻", "哼", "靠", "滚", "操", "变", "态", "一", "二", "三", "万", "亿"
    ]
};

// --- 全局游戏状态 ---
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

// --- 辅助函数 ---
function generateDeck() {
    let deck = [];
    for(let i=0; i<4; i++) deck.push(TILES_CONFIG.wildcard);
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
            name: p.name,
            score: p.score,
            handCount: p.hand.length,
            isDealer: p.isDealer,
            hasWon: p.hasWon,
            isTurn: gameState.status === 'PLAYING' && gameState.players.indexOf(p) === gameState.round.turnIndex,
            history: p.history // 将历史胡牌数据发送给前端
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
        if(gameState.players.indexOf(p) === gameState.round.dealerIndex) {
            lastIndex = p.hand.length - 1;
        }
        io.to(p.id).emit('handUpdate', { hand: p.hand, newTileIndex: lastIndex });
    });

    io.emit('updateGame', getPublicState());
    io.emit('flashMessage', `第 ${gameState.round.wind + 1} 局开始！`);
}

function endRound(isDraw) {
    let dealerIndex = gameState.round.dealerIndex;
    let dealer = gameState.players[dealerIndex];
    let isRenchan = !isDraw && dealer.hasWon;

    if (isRenchan) {
        io.emit('flashMessage', `庄家连庄！`);
    } else {
        io.emit('flashMessage', `庄家轮换`);
        gameState.round.wind++; 
        gameState.round.dealerIndex = (dealerIndex + 1) % gameState.players.length; 
        gameState.players.forEach((p, i) => {
            p.isDealer = (i === gameState.round.dealerIndex);
        });
    }

    // 检查是否结束 (>= 4局)
    if (gameState.round.wind >= 4) {
        gameState.status = 'END';
        io.emit('updateGame', getPublicState());
        // 不再自动开始，等待用户操作
    } else {
        setTimeout(() => { startRound(isRenchan); }, 4000);
    }
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameState.status !== 'LOBBY') return;
        if (gameState.players.length >= 4) return;
        
        const newPlayer = {
            id: socket.id,
            name: name || `玩家${gameState.players.length+1}`,
            hand: [],
            score: 0,
            isReady: false,
            hasWon: false,
            isDealer: false,
            history: [] // 新增：记录该玩家所有胡过的牌
        };
        gameState.players.push(newPlayer);
        socket.emit('joined', { id: socket.id });
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

        if (data.hand && data.hand.length === p.hand.length) {
            p.hand = data.hand; 
        }

        gameState.status = 'VOTING';
        gameState.voting = {
            pitcherId: socket.id,
            pitcherName: p.name,
            pitcherHand: p.hand, 
            votes: {}
        };
        io.emit('startVoting', gameState.voting);
    });

    socket.on('submitVote', (score) => {
        if (gameState.status !== 'VOTING') return;
        if (socket.id === gameState.voting.pitcherId) return;

        gameState.voting.votes[socket.id] = parseInt(score);
        const activePlayerCount = gameState.players.length;
        if (Object.keys(gameState.voting.votes).length >= activePlayerCount - 1) {
            resolveVoting();
        }
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
        
        // --- 核心修改：保存历史记录 ---
        // 使用 slice() 深拷贝数组，防止后续引用修改
        pitcher.history.push([...gameState.voting.pitcherHand]); 
        
        gameState.round.winners.push(pitcher.id);
        const rank = gameState.round.winners.length;
        let baseScore = rank === 1 ? 15 : (rank === 2 ? 10 : 5);
        let creativeScore = Math.floor(totalVotes * 0.5);
        let finalScore = baseScore + creativeScore;

        if (pitcher.isDealer) {
            finalScore = Math.ceil(finalScore * 1.5);
            msg += ` [庄家]`;
        }

        pitcher.score += finalScore;
        msg = `${pitcher.name} 胡牌! 得分${finalScore} (票数${totalVotes})`;
        
        io.emit('voteResult', { success: true, message: msg });
        io.emit('flashMessage', msg);

        const activeCount = gameState.players.length;
        if (gameState.round.winners.length >= activeCount - 1) {
            io.emit('updateGame', getPublicState());
            setTimeout(() => endRound(false), 3000);
            return;
        } 
        
        gameState.status = 'PLAYING';
        if (gameState.players[gameState.round.turnIndex].id === pitcher.id) {
            nextTurn(false); 
        } else {
            io.emit('updateGame', getPublicState());
        }

    } else {
        pitcher.score -= 10;
        msg = `胡牌失败 (票${totalVotes}/${threshold}) 扣10分`;
        
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
