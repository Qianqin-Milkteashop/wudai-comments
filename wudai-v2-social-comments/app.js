// 五代十国关系图 v2 - 改进版核心逻辑

// GitHub Pages 提醒：同一个 https://<username>.github.io 域名下，不同仓库的 localStorage 是共享的。
// 为避免多个项目互相覆盖（导致“删不了自己的评论/数据丢失”等问题），这里统一做 key 前缀隔离，并兼容旧 key 自动迁移。
const STORAGE = {
    prefix: 'wudai_v2_',
    key(name) { return `${this.prefix}${name}`; },
    legacy: {
        userId: 'userId',
        graphData: 'graphData',
        comments: 'comments',
        adminPasswordHash: 'adminPasswordHash',
    }
};

function migrateStorageKey(newKey, legacyKey) {
    if (localStorage.getItem(newKey) === null) {
        const legacyVal = localStorage.getItem(legacyKey);
        if (legacyVal !== null) {
            localStorage.setItem(newKey, legacyVal);
        }
    }
}

// 应用状态
const APP_STATE = {
    isAdmin: false,
    selectedNode: null,
    editingNode: null,
    zoom: null,
    simulation: null,
    lastActionTime: 0,
    actionCount: 0,
    deleteCount: 0,  // 短期删除计数（频率限制用）
    lastDeleteTime: 0,  // 最后删除时间
    totalDeleteCount: 0,  // 用户总删除次数（新增）
    userId: null,  // 用户唯一ID
    petMessages: [
        '欢迎来到五代十国！',
        '点击节点查看详情哦',
        '你可以添加新人物',
        '试试拖动节点重新布局',
        '记得定期备份数据'
    ]
};

// 配置
const CONFIG = {
    adminPasswordHash: null,
    centerNodeId: 'li_cunxu',
    
    // 频率限制配置
    rateLimit: {
        maxActions: 10,        // 最多操作次数
        timeWindow: 60000,     // 时间窗口（毫秒）
        cooldown: 5000,        // 冷却时间
        maxDeletes: 5,         // 最多删除次数（短期）
        deleteWindow: 300000,  // 删除时间窗口（5分钟）
        maxTotalDeletes: 10    // 每个用户最多删除人物总数（新增）
    },
    
    // 敏感词列表
    sensitiveWords: [
        '习近平', '毛泽东', '邓小平', '政府', '共产党', '民主',
        '六四', '天安门', '法轮功', '台独', '藏独', '疆独',
        '操', '妈', '傻逼', '草泥马', '他妈', '你妈', '日',
        '色情', '黄色', '成人', '赌博', '毒品'
    ]
};

// 生成用户唯一ID
function getUserId() {
    // 兼容旧版本：无前缀 userId -> 有前缀 userId
    migrateStorageKey(STORAGE.key('userId'), STORAGE.legacy.userId);

    let userId = localStorage.getItem(STORAGE.key('userId'));
    if (!userId) {
        userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem(STORAGE.key('userId'), userId);
    }
    return userId;
}

// 管理员会话（仅当前标签页有效）
const ADMIN_SESSION = {
    key: STORAGE.key('adminSession'),
    timeKey: STORAGE.key('adminSessionTime'),
    legacyKey: 'adminSession',
    legacyTimeKey: 'adminSessionTime',
    maxAge: 12 * 60 * 60 * 1000 // 12小时
};

function setAdminSession() {
    // 写入新 key
    sessionStorage.setItem(ADMIN_SESSION.key, 'true');
    sessionStorage.setItem(ADMIN_SESSION.timeKey, Date.now().toString());
    // 清理旧 key（避免不同版本并存）
    sessionStorage.removeItem(ADMIN_SESSION.legacyKey);
    sessionStorage.removeItem(ADMIN_SESSION.legacyTimeKey);
}

function clearAdminSession() {
    sessionStorage.removeItem(ADMIN_SESSION.key);
    sessionStorage.removeItem(ADMIN_SESSION.timeKey);
    sessionStorage.removeItem(ADMIN_SESSION.legacyKey);
    sessionStorage.removeItem(ADMIN_SESSION.legacyTimeKey);
}

function isAdminSessionValid() {
    // 兼容旧版本 session key
    const hasNew = sessionStorage.getItem(ADMIN_SESSION.key) === 'true';
    const hasLegacy = sessionStorage.getItem(ADMIN_SESSION.legacyKey) === 'true';
    if (!hasNew && !hasLegacy) return false;

    const t = parseInt(
        (sessionStorage.getItem(ADMIN_SESSION.timeKey) || sessionStorage.getItem(ADMIN_SESSION.legacyTimeKey) || '0'),
        10
    );
    if (!t) return false;
    if (Date.now() - t > ADMIN_SESSION.maxAge) {
        clearAdminSession();
        return false;
    }
    // 如果是旧 key 生效，迁移到新 key
    if (!hasNew && hasLegacy) {
        setAdminSession();
    }
    return true;
}

// 初始化数据
let graphData = {
    nodes: [
        {
            id: 'li_cunxu',
            name: '李存勖',
            position: '后唐庄宗',
            birthYear: '885',
            deathYear: '926',
            personality: '勇武善战，能继父志，然而沉湎戏曲，宠信伶官，终致祸败',
            isCenter: true
        }
    ],
    links: []
};

// 评论数据
let comments = [];
let currentSort = 'hot'; // 当前排序方式：hot热门 或 time时间

// SHA-256 哈希函数
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// 敏感词检测
function containsSensitiveWord(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return CONFIG.sensitiveWords.some(word => 
        lowerText.includes(word.toLowerCase())
    );
}

// 频率限制检查
function checkRateLimit() {
    const now = Date.now();
    const timeSinceLastAction = now - APP_STATE.lastActionTime;
    
    // 如果超过时间窗口，重置计数
    if (timeSinceLastAction > CONFIG.rateLimit.timeWindow) {
        APP_STATE.actionCount = 0;
    }
    
    // 检查是否超过限制
    if (APP_STATE.actionCount >= CONFIG.rateLimit.maxActions) {
        const waitTime = Math.ceil((CONFIG.rateLimit.cooldown - timeSinceLastAction) / 1000);
        if (waitTime > 0) {
            showToast(`操作过于频繁，请等待 ${waitTime} 秒后再试`, 3000);
            return false;
        }
        APP_STATE.actionCount = 0;
    }
    
    APP_STATE.actionCount++;
    APP_STATE.lastActionTime = now;
    return true;
}

// 删除频率检查
function checkDeleteLimit() {
    const now = Date.now();
    const timeSinceLastDelete = now - APP_STATE.lastDeleteTime;
    
    // 如果超过时间窗口，重置计数
    if (timeSinceLastDelete > CONFIG.rateLimit.deleteWindow) {
        APP_STATE.deleteCount = 0;
    }
    
    // 检查是否超过删除限制
    if (APP_STATE.deleteCount >= CONFIG.rateLimit.maxDeletes) {
        const waitTime = Math.ceil((CONFIG.rateLimit.deleteWindow - timeSinceLastDelete) / 60000);
        showToast(`删除过于频繁，请等待 ${waitTime} 分钟后再试`, 3000);
        return false;
    }
    
    APP_STATE.deleteCount++;
    APP_STATE.lastDeleteTime = now;
    return true;
}

// 检查总删除次数限制（新增）
function checkTotalDeleteLimit() {
    // 管理员不受限制
    if (APP_STATE.isAdmin) {
        return true;
    }
    
    // 检查是否超过总删除次数
    if (APP_STATE.totalDeleteCount >= CONFIG.rateLimit.maxTotalDeletes) {
        showToast(`您已达到删除上限（${CONFIG.rateLimit.maxTotalDeletes}次），无法继续删除人物`, 3000);
        petSay('删除次数已用完，请联系管理员');
        return false;
    }
    
    return true;
}

// 保存用户删除计数（新增）
function saveDeleteCount() {
    const deleteCountKey = `${STORAGE.prefix}deleteCount_${APP_STATE.userId}`;
    localStorage.setItem(deleteCountKey, APP_STATE.totalDeleteCount.toString());
}

// Toast 通知
function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// 模态框控制
function openModal(modalId) {
    document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// 初始化
async function init() {
    // 获取用户ID
    APP_STATE.userId = getUserId();
    
    // 加载用户删除计数
    const deleteCountKey = `${STORAGE.prefix}deleteCount_${APP_STATE.userId}`;
    const savedDeleteCount = localStorage.getItem(deleteCountKey);
    if (savedDeleteCount) {
        APP_STATE.totalDeleteCount = parseInt(savedDeleteCount);
    }
    
    // 加载保存的数据
    loadData();
    
    // 初始化关系图
    initGraph();
    
    // 绑定事件
    bindEvents();
    
    // 检查是否有管理员密码
    // 迁移管理员 hash key
    migrateStorageKey(STORAGE.key('adminPasswordHash'), STORAGE.legacy.adminPasswordHash);

    const savedHash = localStorage.getItem(STORAGE.key('adminPasswordHash'));
    if (savedHash) {
        CONFIG.adminPasswordHash = savedHash;
    }

    // 恢复管理员会话（关闭标签页会失效）
    if (CONFIG.adminPasswordHash && isAdminSessionValid()) {
        APP_STATE.isAdmin = true;
        updateAdminUI();
    }
    
    // 加载评论
    loadComments();
    
    // 初始化宠物
    initPet();
    
    // 绑定快捷键
    bindHotkeys();
    
    // 定期自动导出数据（每24小时）
    startAutoBackup();
}

// 加载数据
function loadData() {
    // 迁移 graphData key
    migrateStorageKey(STORAGE.key('graphData'), STORAGE.legacy.graphData);

    const savedData = localStorage.getItem(STORAGE.key('graphData'));
    if (savedData) {
        graphData = JSON.parse(savedData);
    }
}

// 保存数据
function saveData() {
    localStorage.setItem(STORAGE.key('graphData'), JSON.stringify(graphData));
}

// 加载评论
function loadComments() {
    // 迁移 comments key
    migrateStorageKey(STORAGE.key('comments'), STORAGE.legacy.comments);

    const savedComments = localStorage.getItem(STORAGE.key('comments'));
    if (savedComments) {
        comments = JSON.parse(savedComments);
        normalizeComments();
        renderComments();
    }
}

// 保存评论
function saveComments() {
    localStorage.setItem(STORAGE.key('comments'), JSON.stringify(comments));
}

// 兼容旧数据：补全字段，避免权限判断/渲染报错
function normalizeComments() {
    const normalizeOne = (c) => {
        if (!c || typeof c !== 'object') return;
        if (!c.id) c.id = 'comment_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        if (!c.timestamp) c.timestamp = Date.now();
        if (typeof c.likes !== 'number') c.likes = 0;
        // 旧数据可能没有 userId：
        // 因为该项目是纯前端 + localStorage（每个访客看到的通常就是自己浏览器里的数据），
        // 对缺失 userId 的历史评论，默认视为“当前浏览器用户”创建，避免出现“删不了自己的评论”。
        if (!('userId' in c) || c.userId === null || c.userId === '') c.userId = APP_STATE.userId;
    };

    for (const c of comments) {
        normalizeOne(c);
        if (!Array.isArray(c.replies)) c.replies = [];
        for (const r of c.replies) {
            normalizeOne(r);
        }
    }
}

// 渲染评论
function renderComments() {
    const commentsList = document.getElementById('commentsList');
    const commentCount = document.getElementById('commentCount');
    
    if (comments.length === 0) {
        commentsList.innerHTML = '<p class="empty-state">还没有评论，来抢沙发吧！</p>';
        commentCount.textContent = '(0)';
        return;
    }
    
    // 计算总评论数（包括回复）
    const totalCount = comments.reduce((sum, c) => sum + 1 + (c.replies ? c.replies.length : 0), 0);
    commentCount.textContent = `(${totalCount})`;
    
    // 排序评论
    let sortedComments = [...comments];
    if (currentSort === 'hot') {
        sortedComments.sort((a, b) => (b.likes || 0) - (a.likes || 0));
    } else {
        sortedComments.sort((a, b) => b.timestamp - a.timestamp);
    }
    
    commentsList.innerHTML = sortedComments.map(comment => renderComment(comment)).join('');
}

// 渲染单个评论
function renderComment(comment, isReply = false) {
    const likes = comment.likes || 0;
    const replies = comment.replies || [];
    const isLiked = hasLikedComment(comment.id);
    const isOwner = !!comment.userId && comment.userId === APP_STATE.userId;
    const canDelete = APP_STATE.isAdmin || isOwner;
    const canEdit = APP_STATE.isAdmin || isOwner;
    
    const replyClass = isReply ? 'comment-reply' : 'comment-item';
    
    return `
        <div class="${replyClass}" id="comment-${comment.id}">
            <div class="comment-avatar">
                ${getAvatar(comment.author)}
            </div>
            <div class="comment-content">
                <div class="comment-header">
                    <span class="comment-author">${comment.author || '匿名'}</span>
                    <span class="comment-time">${formatTime(comment.timestamp)}${comment.editedAt ? ' · (edited)' : ''}</span>
                </div>
                <div class="comment-text">${escapeHtml(comment.text)}</div>
                <div class="comment-actions">
                    <button class="action-btn ${isLiked ? 'liked' : ''}" onclick="toggleLike('${comment.id}')">
                        <span class="action-icon">${isLiked ? '❤️' : '🤍'}</span>
                        <span class="action-text">${likes > 0 ? likes : '点赞'}</span>
                    </button>
                    ${!isReply ? `
                        <button class="action-btn" onclick="showReplyBox('${comment.id}')">
                            <span class="action-icon">💬</span>
                            <span class="action-text">${replies.length > 0 ? replies.length : '回复'}</span>
                        </button>
                    ` : ''}
                    ${canEdit ? `
                        <button class="action-btn" onclick="showEditBox('${comment.id}')">
                            <span class="action-icon">✏️</span>
                            <span class="action-text">Edit</span>
                        </button>
                    ` : ''}
${canDelete ? `
                        <button class="action-btn delete-btn" onclick="deleteComment('${comment.id}')">
                            <span class="action-icon">🗑️</span>
                            <span class="action-text">删除</span>
                        </button>
                    ` : ''}
                </div>
                <!-- 编辑框 -->
                <div class="edit-box" id="editBox-${comment.id}" style="display: none;">
                    <textarea class="textarea reply-textarea" id="editText-${comment.id}" placeholder="Edit your comment..." rows="2" maxlength="500"></textarea>
                    <div class="reply-actions">
                        <button class="btn btn-secondary btn-sm" onclick="hideEditBox('${comment.id}')">Cancel</button>
                        <button class="btn btn-primary btn-sm" onclick="saveEditedComment('${comment.id}')">Save</button>
                    </div>
                </div>


                
                <!-- 回复框 -->
                <div class="reply-box" id="replyBox-${comment.id}" style="display: none;">
                    <textarea class="textarea reply-textarea" id="replyText-${comment.id}" placeholder="回复 @${comment.author || '匿名'}..." rows="2" maxlength="500"></textarea>
                    <div class="reply-actions">
                        <button class="btn btn-secondary btn-sm" onclick="hideReplyBox('${comment.id}')">取消</button>
                        <button class="btn btn-primary btn-sm" onclick="submitReply('${comment.id}')">回复</button>
                    </div>
                </div>
                
                <!-- 回复列表 -->
                ${replies.length > 0 ? `
                    <div class="replies-container">
                        <div class="replies-header">
                            <span class="replies-count">${replies.length}条回复</span>
                            <button class="replies-toggle" onclick="toggleReplies('${comment.id}')">
                                <span id="toggleText-${comment.id}">展开</span>
                                <span class="toggle-icon" id="toggleIcon-${comment.id}">▼</span>
                            </button>
                        </div>
                        <div class="replies-list" id="replies-${comment.id}" style="display: none;">
                            ${replies.map(reply => renderComment(reply, true)).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

// 获取头像
function getAvatar(name) {
    if (!name || name === '匿名') {
        return '<div class="avatar">👤</div>';
    }
    // 根据名字生成不同颜色的头像
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
    const index = (name.charCodeAt(0) + name.length) % colors.length;
    const initial = name.charAt(0).toUpperCase();
    return `<div class="avatar" style="background: ${colors[index]}">${initial}</div>`;
}

// 转义HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, '<br>');
}

// 格式化时间
function formatTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;
    
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}-${date.getDate()}`;
}

// 提交评论
function submitComment() {
    const name = document.getElementById('commentName').value.trim();
    const text = document.getElementById('commentText').value.trim();
    
    if (!text) {
        showToast('请输入评论内容');
        return;
    }
    
    // 检查敏感词
    if (containsSensitiveWord(name) || containsSensitiveWord(text)) {
        showToast('评论包含敏感词，请修改后重试');
        return;
    }
    
    // 检查频率
    if (!checkRateLimit()) {
        return;
    }
    
    const comment = {
        id: 'comment_' + Date.now(),
        author: name || '匿名',
        text: text,
        timestamp: Date.now(),
        likes: 0,
        replies: [],
        userId: APP_STATE.userId
    };
    
    comments.push(comment);
    saveComments();
    renderComments();
    
    // 清空表单
    document.getElementById('commentName').value = '';
    document.getElementById('commentText').value = '';
    
    showToast('评论已发布');
    petSay('感谢你的评论！');
}

// 提交回复
function submitReply(commentId) {
    const replyText = document.getElementById(`replyText-${commentId}`).value.trim();
    
    if (!replyText) {
        showToast('请输入回复内容');
        return;
    }
    
    // 检查敏感词
    if (containsSensitiveWord(replyText)) {
        showToast('回复包含敏感词，请修改后重试');
        return;
    }
    
    // 检查频率
    if (!checkRateLimit()) {
        return;
    }
    
    const comment = comments.find(c => c.id === commentId);
    if (!comment) return;
    
    const reply = {
        id: 'reply_' + Date.now(),
        author: '匿名',  // 回复默认匿名
        text: replyText,
        timestamp: Date.now(),
        likes: 0,
        userId: APP_STATE.userId
    };
    
    if (!comment.replies) {
        comment.replies = [];
    }
    comment.replies.push(reply);
    
    saveComments();
    renderComments();
    
    // 自动展开回复列表
    showReplies(commentId);
    
    showToast('回复成功');
}

// 显示回复框
function showReplyBox(commentId) {
    const replyBox = document.getElementById(`replyBox-${commentId}`);
    replyBox.style.display = 'block';
    document.getElementById(`replyText-${commentId}`).focus();
}

// 隐藏回复框
function hideReplyBox(commentId) {
    const replyBox = document.getElementById(`replyBox-${commentId}`);
    replyBox.style.display = 'none';
    document.getElementById(`replyText-${commentId}`).value = '';
}

// 查找评论/回复（用于编辑、删除等）
function findCommentById(commentId) {
    const idx = comments.findIndex(c => c.id === commentId);
    if (idx !== -1) {
        return { type: 'comment', comment: comments[idx], parent: null, index: idx };
    }

    for (const c of comments) {
        if (!c.replies) continue;
        const ridx = c.replies.findIndex(r => r.id === commentId);
        if (ridx !== -1) {
            return { type: 'reply', comment: c.replies[ridx], parent: c, index: ridx };
        }
    }

    return null;
}

// 显示编辑框
function showEditBox(commentId) {
    const found = findCommentById(commentId);
    if (!found) return;

    const isOwner = !!found.comment.userId && found.comment.userId === APP_STATE.userId;
    if (!APP_STATE.isAdmin && !isOwner) {
        showToast('只能编辑自己发布的评论（如果你换了浏览器/清了站点数据，身份会变）');
        return;
    }

    // 先收起其他编辑框
    document.querySelectorAll('.edit-box').forEach(el => {
        el.style.display = 'none';
    });

    const editBox = document.getElementById(`editBox-${commentId}`);
    const textarea = document.getElementById(`editText-${commentId}`);
    if (!editBox || !textarea) return;

    textarea.value = found.comment.text || '';
    editBox.style.display = 'block';
    textarea.focus();
}

// 隐藏编辑框
function hideEditBox(commentId) {
    const editBox = document.getElementById(`editBox-${commentId}`);
    const textarea = document.getElementById(`editText-${commentId}`);
    if (editBox) editBox.style.display = 'none';
    if (textarea) textarea.value = '';
}

// 保存编辑
function saveEditedComment(commentId) {
    const textarea = document.getElementById(`editText-${commentId}`);
    if (!textarea) return;
    const newText = textarea.value.trim();

    if (!newText) {
        showToast('评论内容不能为空');
        return;
    }

    if (containsSensitiveWord(newText)) {
        showToast('评论包含敏感词，请修改后重试');
        return;
    }

    const found = findCommentById(commentId);
    if (!found) return;

    if (found.comment.userId !== APP_STATE.userId && !APP_STATE.isAdmin) {
        showToast('只能编辑自己的评论');
        return;
    }

    found.comment.text = newText;
    found.comment.editedAt = Date.now();

    saveComments();
    renderComments();
    showToast('修改已保存');
}


// 切换回复显示
function toggleReplies(commentId) {
    const repliesList = document.getElementById(`replies-${commentId}`);
    const toggleText = document.getElementById(`toggleText-${commentId}`);
    const toggleIcon = document.getElementById(`toggleIcon-${commentId}`);
    
    if (repliesList.style.display === 'none') {
        repliesList.style.display = 'block';
        toggleText.textContent = '收起';
        toggleIcon.textContent = '▲';
    } else {
        repliesList.style.display = 'none';
        toggleText.textContent = '展开';
        toggleIcon.textContent = '▼';
    }
}

// 显示回复列表
function showReplies(commentId) {
    const repliesList = document.getElementById(`replies-${commentId}`);
    const toggleText = document.getElementById(`toggleText-${commentId}`);
    const toggleIcon = document.getElementById(`toggleIcon-${commentId}`);
    
    repliesList.style.display = 'block';
    toggleText.textContent = '收起';
    toggleIcon.textContent = '▲';
}

// 点赞/取消点赞
function toggleLike(commentId) {
    const likeKey = `${STORAGE.prefix}liked_${commentId}_${APP_STATE.userId}`;
    const hasLiked = localStorage.getItem(likeKey);
    
    // 找到评论（可能在主评论或回复中）
    let comment = comments.find(c => c.id === commentId);
    if (!comment) {
        // 在回复中查找
        for (const c of comments) {
            if (c.replies) {
                comment = c.replies.find(r => r.id === commentId);
                if (comment) break;
            }
        }
    }
    
    if (!comment) return;
    
    if (hasLiked) {
        // 取消点赞
        comment.likes = Math.max(0, (comment.likes || 0) - 1);
        localStorage.removeItem(likeKey);
    } else {
        // 点赞
        comment.likes = (comment.likes || 0) + 1;
        localStorage.setItem(likeKey, 'true');
    }
    
    saveComments();
    renderComments();
}

// 检查是否已点赞
function hasLikedComment(commentId) {
    const likeKey = `${STORAGE.prefix}liked_${commentId}_${APP_STATE.userId}`;
    return localStorage.getItem(likeKey) !== null;
}

// 删除评论
function deleteComment(commentId) {
    if (!confirm('确定要删除这条评论吗？')) {
        return;
    }
    
    // 在主评论中查找
    let commentIndex = comments.findIndex(c => c.id === commentId);
    if (commentIndex !== -1) {
        // 检查权限
        const comment = comments[commentIndex];
        const isOwner = !!comment.userId && comment.userId === APP_STATE.userId;
        if (!APP_STATE.isAdmin && !isOwner) {
            showToast('只能删除自己发布的评论（如果你换了浏览器/清了站点数据，身份会变）');
            return;
        }
        comments.splice(commentIndex, 1);
    } else {
        // 在回复中查找
        for (const comment of comments) {
            if (comment.replies) {
                const replyIndex = comment.replies.findIndex(r => r.id === commentId);
                if (replyIndex !== -1) {
                    const reply = comment.replies[replyIndex];
                    const isOwner = !!reply.userId && reply.userId === APP_STATE.userId;
                    if (!APP_STATE.isAdmin && !isOwner) {
                        showToast('只能删除自己发布的评论（如果你换了浏览器/清了站点数据，身份会变）');
                        return;
                    }
                    comment.replies.splice(replyIndex, 1);
                    break;
                }
            }
        }
    }
    
    saveComments();
    renderComments();
    showToast('评论已删除');
}

// 排序评论
function sortComments(sortType) {
    currentSort = sortType;
    
    // 更新按钮状态
    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`.sort-btn[data-sort="${sortType}"]`).classList.add('active');
    
    renderComments();
}

// 插入表情
function insertEmoji(emoji) {
    const textarea = document.getElementById('commentText');
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    
    textarea.value = text.substring(0, start) + emoji + text.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
    textarea.focus();
}

// 初始化D3关系图
function initGraph() {
    const container = document.getElementById('graph');
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // 清空现有内容
    container.innerHTML = '';
    
    // 确保至少有中心节点
    if (graphData.nodes.length === 0) {
        graphData.nodes.push({
            id: 'li_cunxu',
            name: '李存勖',
            position: '后唐庄宗',
            birthYear: '885',
            deathYear: '926',
            personality: '勇武善战，能继父志，然而沉湎戏曲，宠信伶官，终致祸败',
            isCenter: true
        });
        saveData();
    }
    
    console.log('Graph data:', JSON.stringify({
        nodes: graphData.nodes.map(n => ({ id: n.id, name: n.name })),
        links: graphData.links
    }, null, 2));
    
    // 创建SVG
    const svg = d3.select('#graph')
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .attr('viewBox', `0 0 ${width} ${height}`);
    
    // 添加缩放功能
    APP_STATE.zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
        });
    
    svg.call(APP_STATE.zoom);
    
    // 创建主绘图组
    const g = svg.append('g');
    
    // 创建力导向图 - 直接使用graphData，不要拷贝
    APP_STATE.simulation = d3.forceSimulation(graphData.nodes)
        .force('link', d3.forceLink(graphData.links)
            .id(d => d.id)
            .distance(200))
        .force('charge', d3.forceManyBody().strength(-500))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(60))
        .force('x', d3.forceX(width / 2).strength(0.05))
        .force('y', d3.forceY(height / 2).strength(0.05));
    
    // 绘制连线
    const link = g.append('g')
        .attr('class', 'links')
        .selectAll('line')
        .data(graphData.links)
        .enter()
        .append('line')
        .attr('class', 'link')
        .attr('stroke', '#999')
        .attr('stroke-opacity', 0.6)
        .attr('stroke-width', 2);
    
    // 添加关系线标签
    const linkLabel = g.append('g')
        .attr('class', 'link-labels')
        .selectAll('text')
        .data(graphData.links)
        .enter()
        .append('text')
        .attr('class', 'link-label')
        .attr('text-anchor', 'middle')
        .attr('dy', -5)
        .text(d => d.type || '');
    
    // 绘制节点
    const node = g.append('g')
        .attr('class', 'nodes')
        .selectAll('.node')
        .data(graphData.nodes)
        .enter()
        .append('g')
        .attr('class', d => d.isCenter ? 'node center' : 'node')
        .call(d3.drag()
            .on('start', dragStarted)
            .on('drag', dragged)
            .on('end', dragEnded))
        .on('click', (event, d) => {
            event.stopPropagation();
            showPersonDetail(d);
        })
        .on('mouseenter', (event, d) => {
            showNodeTooltip(event, d);
        })
        .on('mouseleave', hideNodeTooltip);
    
    // 节点圆圈
    node.append('circle')
        .attr('r', d => d.isCenter ? 30 : 20);
    
    // 节点文字
    node.append('text')
        .attr('dy', d => d.isCenter ? 4 : 3)
        .text(d => d.name);
    
    // 更新位置
    APP_STATE.simulation.on('tick', () => {
        link
            .attr('x1', d => d.source.x)
            .attr('y1', d => d.source.y)
            .attr('x2', d => d.target.x)
            .attr('y2', d => d.target.y);
        
        linkLabel
            .attr('x', d => (d.source.x + d.target.x) / 2)
            .attr('y', d => (d.source.y + d.target.y) / 2);
        
        node.attr('transform', d => `translate(${d.x},${d.y})`);
    });
    
    // 调试输出
    setTimeout(() => {
        console.log('Links after simulation:', graphData.links.map(l => ({
            source: typeof l.source === 'object' ? l.source.id : l.source,
            target: typeof l.target === 'object' ? l.target.id : l.target,
            type: l.type
        })));
    }, 1000);
    
    // 拖拽函数
    function dragStarted(event, d) {
        if (!event.active) APP_STATE.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }
    
    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }
    
    function dragEnded(event, d) {
        if (!event.active) APP_STATE.simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }
}

// 显示节点悬停提示
function showNodeTooltip(event, person) {
    let tooltip = document.getElementById('nodeTooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'nodeTooltip';
        tooltip.className = 'node-tooltip';
        document.body.appendChild(tooltip);
    }
    
    tooltip.innerHTML = `
        <div class="tooltip-name">${person.name}</div>
        ${person.position ? `<div class="tooltip-item"><span class="tooltip-label">职位：</span>${person.position}</div>` : ''}
        ${person.birthYear || person.deathYear ? `<div class="tooltip-item"><span class="tooltip-label">生卒：</span>${person.birthYear || '?'} - ${person.deathYear || '?'}</div>` : ''}
        ${person.personality ? `<div class="tooltip-item"><span class="tooltip-label">评价：</span>${person.personality}</div>` : ''}
    `;
    
    tooltip.style.left = (event.pageX + 15) + 'px';
    tooltip.style.top = (event.pageY + 15) + 'px';
    tooltip.classList.add('show');
}

// 隐藏节点悬停提示
function hideNodeTooltip() {
    const tooltip = document.getElementById('nodeTooltip');
    if (tooltip) {
        tooltip.classList.remove('show');
    }
}

// 显示人物详情
function showPersonDetail(person) {
    APP_STATE.selectedNode = person;
    const detailDiv = document.getElementById('personDetail');
    
    // 找到与该人物相关的所有关系
    const relatedLinks = graphData.links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        return sourceId === person.id || targetId === person.id;
    });
    
    // 构建关系列表HTML
    let relationsHTML = '';
    if (relatedLinks.length > 0) {
        relationsHTML = '<div class="detail-section"><div class="detail-label">关系</div>';
        relatedLinks.forEach(link => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            const otherNodeId = sourceId === person.id ? targetId : sourceId;
            const otherNode = graphData.nodes.find(n => n.id === otherNodeId);
            
            // 判断是否可以删除：
            // 1. 管理员可以删除任何关系
            // 2. 如果关系没有createdBy（旧数据），任何人都可以删除
            // 3. 如果关系有createdBy，只有创建者可以删除
            const canDelete = APP_STATE.isAdmin || 
                             !link.createdBy || 
                             link.createdBy === APP_STATE.userId;
            
            const deleteBtn = canDelete ? 
                `<button class="relation-delete-btn" onclick="deleteRelation('${sourceId}', '${targetId}')" title="删除关系">×</button>` : '';
            
            relationsHTML += `
                <div class="relation-item">
                    <span class="relation-text">${otherNode ? otherNode.name : '未知'} - ${link.type}</span>
                    ${deleteBtn}
                </div>
            `;
        });
        relationsHTML += '</div>';
    }
    
    detailDiv.innerHTML = `
        <div class="detail-name">${person.name}</div>
        ${person.position ? `
            <div class="detail-section">
                <div class="detail-label">職位</div>
                <div class="detail-value">${person.position}</div>
            </div>
        ` : ''}
        ${person.birthYear || person.deathYear ? `
            <div class="detail-section">
                <div class="detail-label">生卒年</div>
                <div class="detail-value">
                    ${person.birthYear || '?'} - ${person.deathYear || '?'}
                </div>
            </div>
        ` : ''}
        ${person.personality ? `
            <div class="detail-section">
                <div class="detail-label">性格評價</div>
                <div class="detail-value">${person.personality}</div>
            </div>
        ` : ''}
        ${relationsHTML}
        <div class="detail-actions">
            <button class="btn btn-secondary" onclick="editNode('${person.id}')">編輯</button>
            <button class="btn btn-secondary" onclick="addRelationFrom('${person.id}')">添加關係</button>
        </div>
    `;
}

// 编辑节点
function editNode(nodeId) {
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    APP_STATE.editingNode = node;
    
    document.getElementById('editModalTitle').textContent = '编辑人物';
    document.getElementById('editName').value = node.name;
    document.getElementById('editPosition').value = node.position || '';
    document.getElementById('editBirthYear').value = node.birthYear || '';
    document.getElementById('editDeathYear').value = node.deathYear || '';
    document.getElementById('editPersonality').value = node.personality || '';
    
    // 显示删除按钮的条件：
    // 1. 不是中心节点
    // 2. 任何人都可以删除（有频率限制）
    const deleteBtn = document.getElementById('deletePersonBtn');
    const canDelete = !node.isCenter;
    deleteBtn.style.display = canDelete ? 'inline-block' : 'none';
    
    openModal('editModal');
}

// 添加新人物
function addNewPerson() {
    APP_STATE.editingNode = null;
    
    document.getElementById('editModalTitle').textContent = '添加新人物';
    document.getElementById('editName').value = '';
    document.getElementById('editPosition').value = '';
    document.getElementById('editBirthYear').value = '';
    document.getElementById('editDeathYear').value = '';
    document.getElementById('editPersonality').value = '';
    document.getElementById('deletePersonBtn').style.display = 'none';
    
    openModal('editModal');
}

// 保存人物
function savePerson() {
    const name = document.getElementById('editName').value.trim();
    if (!name) {
        showToast('请输入姓名');
        return;
    }
    
    const personData = {
        name,
        position: document.getElementById('editPosition').value.trim(),
        birthYear: document.getElementById('editBirthYear').value.trim(),
        deathYear: document.getElementById('editDeathYear').value.trim(),
        personality: document.getElementById('editPersonality').value.trim()
    };
    
    // 检查敏感词
    if (containsSensitiveWord(name) || containsSensitiveWord(personData.position) || 
        containsSensitiveWord(personData.personality)) {
        showToast('内容包含敏感词，请修改后重试');
        return;
    }
    
    // 非管理员检查频率
    if (!APP_STATE.isAdmin && !checkRateLimit()) {
        return;
    }
    
    if (APP_STATE.editingNode) {
        // 编辑现有节点
        Object.assign(APP_STATE.editingNode, personData);
        showToast('保存成功');
    } else {
        // 添加新节点，记录创建者
        const newNode = {
            id: 'person_' + Date.now(),
            ...personData,
            createdBy: APP_STATE.userId,  // 记录创建者
            createdAt: Date.now()
        };
        graphData.nodes.push(newNode);
        showToast('添加成功');
    }
    
    saveData();
    initGraph();
    closeModal('editModal');
    petSay('人物信息已更新！');
}

// 删除人物
function deletePerson() {
    if (!APP_STATE.editingNode || APP_STATE.editingNode.isCenter) {
        showToast('该人物不能删除');
        return;
    }
    
    const node = APP_STATE.editingNode;
    
    // 非管理员需要检查总删除次数限制（新增）
    if (!APP_STATE.isAdmin && !checkTotalDeleteLimit()) {
        return;
    }
    
    // 非管理员需要检查删除频率
    if (!APP_STATE.isAdmin && !checkDeleteLimit()) {
        return;
    }
    
    if (!confirm(`确定要删除 ${node.name} 吗？`)) {
        return;
    }
    
    // 删除节点和相关连线
    const nodeId = node.id;
    graphData.nodes = graphData.nodes.filter(n => n.id !== nodeId);
    graphData.links = graphData.links.filter(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        return sourceId !== nodeId && targetId !== nodeId;
    });
    
    // 非管理员增加删除计数（新增）
    if (!APP_STATE.isAdmin) {
        APP_STATE.totalDeleteCount++;
        saveDeleteCount();
        
        const remaining = CONFIG.rateLimit.maxTotalDeletes - APP_STATE.totalDeleteCount;
        showToast(`删除成功！剩余删除次数：${remaining}次`);
    } else {
        showToast('删除成功');
    }
    
    saveData();
    initGraph();
    closeModal('editModal');
    document.getElementById('personDetail').innerHTML = '<p class="empty-state">点击节点查看详情</p>';
}

// 添加关系（从特定节点）
function addRelationFrom(fromNodeId) {
    // 填充选择框
    const fromSelect = document.getElementById('relationFrom');
    const toSelect = document.getElementById('relationTo');
    
    fromSelect.innerHTML = '<option value="">选择人物</option>';
    toSelect.innerHTML = '<option value="">选择人物</option>';
    
    graphData.nodes.forEach(node => {
        const option1 = new Option(node.name, node.id);
        const option2 = new Option(node.name, node.id);
        fromSelect.add(option1);
        toSelect.add(option2);
    });
    
    if (fromNodeId) {
        fromSelect.value = fromNodeId;
    }
    
    openModal('relationModal');
}

// 添加关系（通用）
function addRelation() {
    addRelationFrom(null);
}

// 保存关系
function saveRelation() {
    const from = document.getElementById('relationFrom').value;
    const to = document.getElementById('relationTo').value;
    let type = document.getElementById('relationType').value;
    
    // 处理自定义关系类型
    if (type === 'custom') {
        const customType = document.getElementById('customRelationType').value.trim();
        if (!customType) {
            showToast('请输入自定义关系名称');
            return;
        }
        if (containsSensitiveWord(customType)) {
            showToast('关系名称包含敏感词，请修改');
            return;
        }
        type = customType;
    }
    
    if (!from || !to) {
        showToast('请选择两个人物');
        return;
    }
    
    if (from === to) {
        showToast('不能添加自己到自己的关系');
        return;
    }
    
    // 检查关系是否已存在
    const exists = graphData.links.some(l => {
        const sourceId = typeof l.source === 'object' ? l.source.id : l.source;
        const targetId = typeof l.target === 'object' ? l.target.id : l.target;
        return (sourceId === from && targetId === to) || (sourceId === to && targetId === from);
    });
    
    if (exists) {
        showToast('该关系已存在');
        return;
    }
    
    // 非管理员检查频率
    if (!APP_STATE.isAdmin && !checkRateLimit()) {
        return;
    }
    
    const newLink = {
        source: from,
        target: to,
        type: type,
        createdBy: APP_STATE.userId,  // 记录创建者
        createdAt: Date.now()
    };
    
    graphData.links.push(newLink);
    saveData();
    initGraph();
    showToast('关系添加成功');
    closeModal('relationModal');
    petSay('新关系已建立！');
}

// 删除关系
function deleteRelation(sourceId, targetId) {
    // 找到要删除的关系
    const linkIndex = graphData.links.findIndex(l => {
        const sId = typeof l.source === 'object' ? l.source.id : l.source;
        const tId = typeof l.target === 'object' ? l.target.id : l.target;
        return (sId === sourceId && tId === targetId) || (sId === targetId && tId === sourceId);
    });
    
    if (linkIndex === -1) {
        showToast('关系不存在');
        return;
    }
    
    const link = graphData.links[linkIndex];
    
    // 检查权限：
    // 1. 管理员可以删除任何关系
    // 2. 如果关系没有createdBy（旧数据），任何人都可以删除
    // 3. 如果关系有createdBy，只有创建者可以删除
    const canDelete = APP_STATE.isAdmin || 
                     !link.createdBy || 
                     link.createdBy === APP_STATE.userId;
    
    if (!canDelete) {
        showToast('只能删除自己创建的关系');
        return;
    }
    
    // 非管理员需要检查删除频率
    if (!APP_STATE.isAdmin && !checkDeleteLimit()) {
        return;
    }
    
    // 获取关系两端的人物名字
    const sourceNode = graphData.nodes.find(n => n.id === sourceId);
    const targetNode = graphData.nodes.find(n => n.id === targetId);
    const relationDesc = `${sourceNode ? sourceNode.name : '未知'} - ${link.type} - ${targetNode ? targetNode.name : '未知'}`;
    
    if (!confirm(`确定要删除关系 "${relationDesc}" 吗？`)) {
        return;
    }
    
    // 删除关系
    graphData.links.splice(linkIndex, 1);
    
    saveData();
    initGraph();
    showToast('关系已删除');
    
    // 如果当前选中的节点是关系中的一个，刷新详情
    if (APP_STATE.selectedNode && 
        (APP_STATE.selectedNode.id === sourceId || APP_STATE.selectedNode.id === targetId)) {
        showPersonDetail(APP_STATE.selectedNode);
    }
}

// 切换自定义关系输入框
function toggleCustomRelation() {
    const select = document.getElementById('relationType');
    const customGroup = document.getElementById('customRelationGroup');
    
    if (select.value === 'custom') {
        customGroup.style.display = 'block';
    } else {
        customGroup.style.display = 'none';
    }
}

// 管理员验证
async function verifyAdmin() {
    const password = document.getElementById('adminPassword').value;
    if (!password) {
        showToast('请输入密码');
        return;
    }
    
    // 密码强度检查
    if (!CONFIG.adminPasswordHash && password.length < 8) {
        showToast('密码至少需要8位字符');
        return;
    }
    
    if (!CONFIG.adminPasswordHash && !/[a-zA-Z]/.test(password)) {
        showToast('密码需要包含字母');
        return;
    }
    
    if (!CONFIG.adminPasswordHash && !/[0-9]/.test(password)) {
        showToast('密码需要包含数字');
        return;
    }
    
    const hash = await hashPassword(password);
    
    if (!CONFIG.adminPasswordHash) {
        // 首次设置密码
        CONFIG.adminPasswordHash = hash;
        localStorage.setItem(STORAGE.key('adminPasswordHash'), hash);
        // 清理旧 key
        localStorage.removeItem(STORAGE.legacy.adminPasswordHash);
        APP_STATE.isAdmin = true;
        setAdminSession();
        showToast('✅ 管理员密码设置成功');
        closeModal('adminModal');
        petSay('欢迎，管理员！');
        updateAdminUI();
    } else if (hash === CONFIG.adminPasswordHash) {
        // 验证成功
        APP_STATE.isAdmin = true;
        setAdminSession();
        showToast('✅ 管理员登录成功');
        closeModal('adminModal');
        petSay('欢迎回来，管理员！');
        updateAdminUI();
    } else {
        showToast('❌ 密码错误');
    }
}

// 更新管理员UI
function updateAdminUI() {
    const floatingActions = document.querySelector('.floating-actions');

    // 退出管理员：移除管理员按钮
    if (!APP_STATE.isAdmin) {
        const dt = document.getElementById('adminDataToolBtn');
        const ex = document.getElementById('exportDataBtn');
        if (dt) dt.remove();
        if (ex) ex.remove();
        renderComments();
        return;
    }

    if (APP_STATE.isAdmin) {
        showToast('🔐 管理员模式已激活', 2000);
        petSay('管理员权限已激活！');
        
        // 动态添加管理员专用按钮到浮动操作栏
        
        // 检查是否已经添加过
        if (!document.getElementById('adminDataToolBtn')) {
            // 添加数据管理按钮
            const dataToolBtn = document.createElement('button');
            dataToolBtn.id = 'adminDataToolBtn';
            dataToolBtn.className = 'fab fab-secondary';
            dataToolBtn.title = '数据管理';
            dataToolBtn.innerHTML = '<span class="fab-icon">⚙</span><span class="fab-text">数据管理</span>';
            dataToolBtn.onclick = () => window.location.href = 'data-tool.html';
            floatingActions.appendChild(dataToolBtn);
            
            // 添加导出备份按钮
            const exportBtn = document.createElement('button');
            exportBtn.id = 'exportDataBtn';
            exportBtn.className = 'fab fab-secondary';
            exportBtn.title = '导出备份';
            exportBtn.innerHTML = '<span class="fab-icon">💾</span><span class="fab-text">导出备份</span>';
            exportBtn.onclick = autoExportData;
            floatingActions.appendChild(exportBtn);
        }

        // 登录后刷新评论按钮权限（管理员可删/改所有评论）
        renderComments();
    }
}

// 退出管理员模式
function logoutAdmin() {
    if (!APP_STATE.isAdmin) return;
    APP_STATE.isAdmin = false;
    clearAdminSession();
    showToast('🔓 已退出管理员模式', 2000);
    petSay('已退出管理员模式');
    updateAdminUI();
}

// 初始化宠物
function initPet() {
    const pet = document.getElementById('webPet');
    
    pet.addEventListener('click', () => {
        const messages = APP_STATE.petMessages;
        const randomMsg = messages[Math.floor(Math.random() * messages.length)];
        petSay(randomMsg);
    });
    
    // 定时随机说话
    setInterval(() => {
        if (Math.random() < 0.1) { // 10%概率
            const messages = APP_STATE.petMessages;
            const randomMsg = messages[Math.floor(Math.random() * messages.length)];
            petSay(randomMsg);
        }
    }, 30000); // 每30秒检查一次
}

// 宠物说话
function petSay(message) {
    const bubble = document.getElementById('petBubble');
    bubble.textContent = message;
    bubble.classList.add('show');
    
    setTimeout(() => {
        bubble.classList.remove('show');
    }, 3000);
}

// 绑定快捷键
function bindHotkeys() {
    document.addEventListener('keydown', (event) => {
        const key = (event.key || '').toLowerCase();

        // Admin shortcut (changed to avoid browser screenshot conflicts):
        // - Windows/Linux: Ctrl + Alt + Shift + A
        // - macOS: Cmd  + Option + Shift + A
        // Backup: Ctrl/Cmd + Shift + L
        const comboPrimary = (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && key === 'a';
        const comboBackup  = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && key === 'l';

        // Exit admin mode:
        // - Windows/Linux: Ctrl + Alt + Shift + E
        // - macOS: Cmd  + Option + Shift + E
        const comboExit = (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && key === 'e';

        if (comboExit) {
            event.preventDefault();
            if (APP_STATE.isAdmin) {
                logoutAdmin();
            } else {
                showToast('当前不在管理员模式', 1600);
            }
            return;
        }

        if (comboPrimary || comboBackup) {
            event.preventDefault();
            openModal('adminModal');
        }
    });
}

// 绑定事件
function bindEvents() {
    // 添加人物按钮
    document.getElementById('addPersonBtn').addEventListener('click', addNewPerson);
    
    // 添加关系按钮
    document.getElementById('addRelationBtn').addEventListener('click', addRelation);
    
    // 提交评论按钮
    document.getElementById('submitComment').addEventListener('click', submitComment);
    
    // 缩放控制
    document.getElementById('zoomIn').addEventListener('click', () => {
        d3.select('#graph svg')
            .transition()
            .call(APP_STATE.zoom.scaleBy, 1.3);
    });
    
    document.getElementById('zoomOut').addEventListener('click', () => {
        d3.select('#graph svg')
            .transition()
            .call(APP_STATE.zoom.scaleBy, 0.7);
    });
    
    document.getElementById('resetZoom').addEventListener('click', () => {
        d3.select('#graph svg')
            .transition()
            .call(APP_STATE.zoom.transform, d3.zoomIdentity);
    });
}

// 自动导出数据
function autoExportData() {
    const data = JSON.stringify(graphData, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wudai-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('数据已导出！');
    petSay('备份完成，数据很安全！');
}

// 启动自动备份
function startAutoBackup() {
    // 检查上次备份时间
    const lastBackup = localStorage.getItem('lastBackupTime');
    const now = Date.now();
    
    if (!lastBackup || now - parseInt(lastBackup) > 86400000) { // 24小时
        // 提醒用户备份
        setTimeout(() => {
            if (APP_STATE.isAdmin) {
                petSay('提醒：已经很久没有备份数据了！');
            }
        }, 5000);
    }
    
    // 每24小时提醒一次
    setInterval(() => {
        if (APP_STATE.isAdmin) {
            petSay('提醒：记得导出备份哦！');
        }
    }, 86400000);
}

// 保存备份时间
function markBackupTime() {
    localStorage.setItem('lastBackupTime', Date.now().toString());
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
