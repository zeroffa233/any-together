#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""Render a Chinese-display copy of the bmad-brainstorming technique composer page.

Post-processes the generated page instead of editing the skill: brain.py and
brain-methods.csv are installer-managed and are overwritten on every
`npx bmad-method install`. Re-run this after an upgrade to rebuild.

Only the *visible* layer is translated. Every machine-readable value the skill
parses out of the pasted prompt stays English on purpose:
  - data-mode      -> "Facilitation mode: <mode>."
  - data-name/desc -> the technique lines
  - data-invent    -> "invent 1 new technique in the spirit of <category>"
  - data-goal      -> filter tags
So the paste stays exactly the contract bmad-brainstorming expects to read.

Usage: uv run _bmad/custom/brain_selector_zh.py [--src PATH] [--out PATH]
"""

import argparse
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".claude/skills/bmad-brainstorming/assets/brain-selector.html"
OUT = ROOT / "_bmad/custom/brain-selector-zh.html"

# --- category display names (pretty(slug) -> Chinese) -------------------------
CATS = {
    "Proven & Professional": "经典 · 久经验证",
    "Structured": "结构化",
    "Deep": "深度挖掘",
    "Creative": "创造性",
    "Biomimetic": "仿生",
    "Cultural": "文化",
    "Speculative Future": "未来推演",
    "Quantum": "量子隐喻",
    "Wild": "狂野",
    "Absurdist": "荒诞",
    "Theatrical": "戏剧扮演",
    "Constraint": "极限约束",
    "Introspective Delight": "内省",
    "Collaborative": "协作",
}

# --- super-group headers ------------------------------------------------------
GROUPS = {
    "Proven & Professional": "经典 · 久经验证",
    "Structured & Analytical": "结构化与分析",
    "Creative & Generative": "创造与生成",
    "Wild & Playful": "狂野与玩闹",
    "Introspective & Personal": "内省与个人",
    "More": "更多",
}

# --- good_for goal labels -----------------------------------------------------
GOALS = {
    "Build a feature": "做功能",
    "Novel concept": "全新概念",
    "Strategy": "战略",
    "Planning": "规划",
    "Diagnose": "诊断问题",
    "Personal / life": "个人 / 生活",
    "Get unstuck": "破除卡壳",
}

# --- 108 techniques: English name -> (中文名, 中文描述) ------------------------
TECH = {
    # collaborative
    "Yes And Building": ("是的,而且", "永不否定;每个人都以「是的,而且……」开口,在上一个想法上继续叠加,堆出一条只进不退的接龙"),
    "Brain Writing Round Robin": ("轮转笔写", "所有人各自默写想法,然后把纸传给下一个人;你只能在传到面前的那张上继续写,一轮接一轮"),
    "Random Stimulation": ("随机刺激", "抽一个随机的词或图,强行和问题挂钩:「这玩意儿能怎么点醒这个问题?」"),
    "Role Playing": ("角色扮演", "每个人代言一个不同的利益相关者,说出那个角色想要什么、怕什么、会对这个想法提什么要求"),
    "Ideation Relay Race": ("创意接力赛", "每人 30 秒,不许停:抛出一个想法就拍给下一个人,让接力棒在所有人过度思考之前一直跑"),
    "Idea Hot Potato": ("想法烫手山芋", "一个想法在圈里传,每个接住的人必须在 10 秒内把它变异掉再传出去,不许重复"),
    "Steal And Upgrade": ("偷来再升级", "挑一个你眼馋的邻座想法,大声认领,然后当众把它改得更好再还回去"),
    "Fold The Paper": ("折纸接龙", "每人只在一幅被遮住的画或一句话上添一笔,只能看到上一段残片,最后展开那个超现实的整体"),
    # creative
    "What If Scenarios": ("假如情景", "一次引爆一个约束——预算无限、结论反过来、问题凭空消失——然后追着涌进来的东西跑"),
    "Analogical Thinking": ("类比思考", "问「这像什么?」,然后从给出答案的那个领域里把解法模式直接偷过来"),
    "First Principles Thinking": ("第一性原理", "把每一条假设都剥到基岩事实,然后只用真理从零重建解法"),
    "Forced Relationships": ("强制关联", "随机抓两个毫不相干的东西,硬在它们之间架桥,直到一个想法掉出来"),
    "Time Shifting": ("时代穿越", "以 1900 年代的匠人身份解这个问题,再以 2150 年的殖民者身份解一遍——收割各自时代特有的约束和花招"),
    "Metaphor Mapping": ("隐喻映射", "宣称这个问题「就是」某个隐喻,把隐喻彻底展开,再把每个部分映射回来找洞察"),
    "Cross-Pollination": ("跨界授粉", "问一个天差地别的行业——赌场、急诊室、养蜂——会怎么破这个局,然后把他们的招数改造过来"),
    "Concept Blending": ("概念融合", "把两个概念熔成一个全新的杂交品类,给这场合并「变成」的东西命名,而不只是「加起来」"),
    "Reverse Brainstorming": ("逆向头脑风暴", "不生成解法而是生成问题——「我们要怎么才能让它彻底失败?」——再把每一条挖出它的反面"),
    "Sensory Exploration": ("感官探索", "用每一种感官拷问这个想法——它的味道、气味、声音、质感——逼出非分析性的角度"),
    # deep
    "Five Whys": ("五问法", "连问五次「为什么」,每个答案喂给下一问,直到砸穿症状触到根因"),
    "Provocation Technique": ("挑衅法", "故意抛出一句荒谬的话,然后从中挖矿:「这怎么可能有用?」把藏在里面的可用原则提取出来"),
    "Assumption Reversal": ("假设反转", "列出问题里埋着的每一条假设,逐条翻成反面,再在这个颠倒的地基上重建解法"),
    "Question Storming": ("问题风暴", "只生成问题,一个答案都不许有,直到那个真正值得解的问题浮现出来"),
    "Constraint Mapping": ("约束测绘", "把每一条约束都画出来,分清真实的和想象的,然后逐个攻击:溶解它、绕开它,或把它变成资产"),
    "Failure Analysis": ("失败解剖", "解剖一个相关的失败案例:什么崩了、为什么崩、留下什么教训、这教训怎么用在这里"),
    "Emergent Thinking": ("涌现思考", "别再硬凑解法;观察这个系统反复产出的是什么模式,给那个正在自己冒头的东西命名"),
    "Causal Loop Mapping": ("因果回路图", "把连接因与果的反馈回路画出来,找到增强回路和平衡回路,瞄准那个杠杆点"),
    "Morphological Analysis": ("形态分析", "列出问题的各个独立参数,为每个参数生成选项,再跨参数组合,逼出没人试过的配置"),
    "Laddering": ("阶梯追问", "不断问「那能给你带来什么?」一路往上爬,直到触到真正的底层需求,然后在那个层次重新构思"),
    # introspective_delight
    "Inner Child Conference": ("内在小孩会议", "用你 7 岁的自己回答:问天真的「为什么为什么为什么」,追着好奇心跑,禁止一切无聊的成年人念头"),
    "Shadow Work Mining": ("阴影挖掘", "说出你在这件事上正在回避、抗拒或害怕的东西——然后往那儿挖,埋着的洞察就在那里"),
    "Values Archaeology": ("价值观考古", "不停问「我为什么在乎?」直到触到基岩:那个在暗中操纵选择的、不可让渡的价值"),
    "Future Self Interview": ("未来自我访谈", "采访 80 岁那个睿智的自己对这个问题的看法,把他给你的建议记下来"),
    "Body Wisdom Dialogue": ("身体智慧对话", "扫描每个选项触发的紧绷、心颤或直觉拉扯;让身体的「是/否」来驱动想法"),
    "Permission Giving": ("授予许可", "给自己写一张明确的许可条,允许自己想那个被禁止的、不可能的念头——然后大声把它想出来"),
    "Secret Wish Confession": ("秘密愿望坦白", "低声说出你在这件事上偷偷想要、却不肯承认的那个尴尬的东西,然后造一个成全它的想法"),
    "Mood Weather Report": ("心情天气预报", "报出此刻的内心天气(雾、暴风雨、晴),让那个确切的情绪气候来生成想法"),
    # structured
    "SCAMPER Method": ("SCAMPER 法", "把想法过一遍七重镜头:替代、组合、改造、修改、他用、消除、反转"),
    "Six Thinking Hats": ("六顶思考帽", "一次一顶,从六个方向审视问题:事实、感受、收益、风险、新点子、流程"),
    "Decision Tree Mapping": ("决策树测绘", "画出每一个选择点和它分岔出的路径,沿每条枝走到它的结局和风险"),
    "Solution Matrix": ("解法矩阵", "把问题变量和解法路径做成网格,给每一格打分,猎取最佳配对和空白缺口"),
    "Trait Transfer": ("特质移植", "说清一个不相干的成功案例为什么能成,然后把那些制胜特质嫁接到你自己的问题上"),
    "Lotus Blossom": ("莲花绽放", "把主题放在 3x3 网格中心,填满周围 8 格,再把这 8 个各自提升为一个新 3x3 的中心"),
    "Worst Possible Idea": ("最烂点子", "故意生成你能想到的最糟糕的解法,然后把每一个翻转成它教给你的正确做法"),
    "Disney Method": ("迪士尼法", "让想法轮流进三个房间:梦想家(什么都行)、现实家(我们会怎么造)、批评家(哪儿会崩)"),
    "Starbursting": ("星爆提问", "只用问题拷问这个想法——谁、什么、哪里、何时、为什么、怎么做——每一类都问干净了再回答任何一个"),
    "Mind Mapping": ("思维导图", "从中心主题向外分枝,每个节点再生子节点;岔路把你拉到哪就跟到哪,让这张网肆意蔓延"),
    "Crazy 8s": ("疯狂八格", "八分钟八个想法,一格一个,不许修改——速度跑赢你内心那个批评家"),
    "How Might We": ("我们可以怎样", "先把问题重构成一批「我们可以怎样……」的机会式提问,再挑最锋利的那个来构思"),
    "Job to Be Done": ("待办任务", "问用户真正雇这个东西来干什么,然后围绕那个底层任务构思,而不是你臆想的那个功能"),
    "Empathy Map": ("同理心地图", "画出用户围绕这个问题说什么、想什么、做什么、感受什么,再从每个象限挖未被满足的需求"),
    "Backcasting": ("回溯规划", "先把完成后的未来定死到有画面的细节,再一步步倒推回你必须先走的那一步"),
    # theatrical
    "Time Travel Talk Show": ("时空脱口秀", "主持一档脱口秀,采访你的过去、现在和未来的自己,从每个时代挖出对这个问题的建议"),
    "Alien Anthropologist": ("外星人类学家", "变成一个困惑的外星人研究这个问题,大声讲出哪些地方看着奇怪、随意或者根本就疯了"),
    "Dream Fusion Laboratory": ("梦境融合实验室", "先说出那个不可能的幻想解法,再逆向工程出通回现实的桥梁步骤"),
    "Emotion Orchestra": ("情绪交响乐", "让每一种情绪(暴怒、狂喜、恐惧、希望)各自主导一轮构思,再把它们互相冲突的想法调和起来"),
    "Parallel Universe Cafe": ("平行宇宙咖啡馆", "改写现实的一条基本规则(物理、经济、社会规范),在那套法则下解这个问题"),
    "Persona Journey": ("角色旅程", "附身一个原型人物,以角色身份解这个问题,说出那个人格看到了什么你平时会漏掉的东西"),
    "Devil's Advocate Courtroom": ("魔鬼代言人法庭", "开一场庭审:起诉这个想法、为它辩护、再宣读陪审团裁决,每个角色都要完全入戏地把话说尽"),
    # wild
    "Chaos Engineering": ("混沌工程", "故意用一切可能失败的方式击碎你的想法,然后只重建那些从残骸里活下来的部分"),
    "Guerrilla Gardening Ideas": ("游击种植", "把你的解法种在最出人意料的地方,让它在地下悄悄长,直到有一天惊到所有人"),
    "Pirate Code Brainstorm": ("海盗法典", "从任何地方偷最好的部分,不打招呼直接混音,抓到能用的就跑"),
    "Zombie Apocalypse Planning": ("末日废土规划", "社会刚刚崩塌——把你的想法剥到只剩没电、没规则、没有备份也能活下来的那部分"),
    "Drunk History Retelling": ("醉酒重述", "像喝了三杯之后那样讲它:没有滤镜、没有黑话,只有那个蠢到极致的大白话真相"),
    "Anti-Solution": ("反解法", "头脑风暴怎么把问题搞得惊天动地地更糟,然后把每一条破坏都反转成一个修复"),
    "Elemental Forces": ("四元素之力", "让火、水、土、风各自用自己那套残暴方式雕刻你的想法,看看什么能活下来"),
    # biomimetic
    "Nature's Solutions": ("自然的解法", "说出一个已经解决了你这个问题的生物,然后把它的机制抄进你的设计"),
    "Ecosystem Thinking": ("生态系统思考", "把你的问题画成一个生态系统:谁吃谁、谁结盟、什么在腐败、什么在填补空缺"),
    "Evolutionary Pressure": ("进化压力", "生一大堆丑陋的变种,施加一条残酷的选择规则,让幸存者繁殖,反复迭代直到它适应"),
    "Predator & Prey": ("捕食者与猎物", "挑一个对你想法的威胁,然后设计一只动物会进化出来对抗它的防御、伪装或逃脱"),
    "Metamorphosis Stages": ("变态发育", "强迫你的想法走过卵、幼虫、蛹、成虫:每个生命阶段都是一个截然不同的形态和目的"),
    "Swarm Logic": ("群体逻辑", "禁止总体规划:让每个个体只遵循笨拙的局部规则,靠自下而上涌现出秩序来解决它"),
    # quantum
    "Observer Effect": ("观察者效应", "问「观察、度量或发布这个想法」这个动作本身,如何改变了你正想捕捉的那个东西"),
    "Entanglement Thinking": ("量子纠缠思考", "把问题里相距最远的两个部分配对,强行认定改动一个会瞬间翻转另一个——逼出那条隐藏的联结"),
    "Superposition Collapse": ("叠加态坍缩", "让所有互相竞争的解法同时活着,然后说出那一条能把它们坍缩成唯一赢家的约束"),
    "Relativity Frame Shift": ("相对论换参考系", "从一个截然不同的观察者参考系重跑这个想法——迟钝的用户、竞争对手、未来的你——看什么会扭曲"),
    "Field Lines": ("场线图", "把目标当成一个电荷,画出把每个利益相关者拉向它或推离它的那些看不见的力"),
    "Quantum Tunneling": ("量子隧穿", "假定这个想法能直接穿过那道「不可能」的壁垒而不是翻过去——那么另一边是什么,又是怎么低成本到达的"),
    # cultural
    "Indigenous Wisdom": ("原住民智慧", "问一个原住民或传统知识体系会怎么面对这件事——指名那个文化,引出它祖传的解题方式"),
    "Fusion Cuisine": ("融合料理", "挑两个不相干的文化,强行混血它们的做法;收割那个任何一方单独都发明不出来的杂交品"),
    "Ritual Innovation": ("仪式创新", "把这个想法重新设计成一场典礼——定义那道门槛、那些手势、参与者所经历的蜕变"),
    "Mythic Frameworks": ("神话框架", "把问题映射到一则神话上:指认原型、找到那个平行的故事,让它的结构来决定结局"),
    "Proverb Mining": ("谚语挖矿", "收集多个文化里关于这个主题的谚语,然后用跟你的假设冲突最狠的那一条来构建解法"),
    "Ancestor Council": ("先祖议会", "召集三位来自不同传统的先祖或长者,让每一位对你的想法各下一道裁决,再调和他们的分歧"),
    "Trickster's Gambit": ("骗术师的诡计", "附身骗术师原型——郊狼、阿南西、洛基——靠作弊、颠倒或打破那条神圣规则来解决它"),
    # absurdist
    "Villain's Monologue": ("反派独白", "把你的问题当成一个邪恶主脑在得意洋洋地炫耀他的阴谋;那个恶毒计划会暴露真正的解法"),
    "Explain It to a Golden Retriever": ("讲给金毛听", "把这个想法重新推销给一只只在乎零食、球和睡觉的兴奋的狗;只留下能活下来的那部分"),
    "Infomercial at 3AM": ("凌晨三点电视购物", "把你半生不熟的想法当成一段绝望的深夜电视购物来卖:「先别急,还有更多!」一直喊到功能自己掉出来"),
    "Drunk Uncle at Thanksgiving": ("年夜饭上的醉酒大伯", "让你家嗓门最大、最没滤镜的亲戚对这个问题开喷;从那些疯癫的暴论里挖埋着的真相"),
    "Cursed Genie": ("恶魔灯神", "许一个愿,然后让一个恶意的灯神用最「技术上完全正确」的灾难方式实现它;逐个堵上漏洞"),
    "Three Rounds of Stupid": ("三轮愚蠢", "第一轮荒谬的想法,第二轮把每个变得更荒谬,第三轮在最蠢的那个里找出藏着的最小的正经东西"),
    # constraint
    "Kill the Crown Jewel": ("砍掉皇冠明珠", "删掉那个最好、最受宠爱的功能——现在重新设计整个东西,让它没有这个也能赢"),
    "1000x Budget": ("千倍预算", "假装钱、时间和人都是无限的——设计出那个荒唐的版本,再从里面挖出你真能偷来用的想法"),
    "Ship in 60 Minutes": ("60 分钟内发布", "一小时后就要上线,只能用手头已有的东西——说清楚你砍了什么、假造了什么、借了什么才让它成真"),
    "The $0 Mandate": ("零预算军令", "花费严格为零地达成目标——不许买工具、不许招人、不许投广告;只有人、人情,和你已经拥有的东西"),
    "One Feature Only": ("只留一个功能", "你只能保留恰好一个能力,其他全没——挑出它,然后把这一件事做到好得离谱"),
    "Crank the Dial to 11": ("旋钮拧到 11", "挑一个维度把它夸张到荒谬的极端——最快、最大、最便宜、最怪——看看什么会被撑开"),
    "Constraint Roulette": ("约束轮盘赌", "每一轮抽一条残酷的随机限制(没有屏幕、团队减半、只剩一天),在它之下重解一遍;幸存者才算真想法"),
    # speculative_future
    "Time Horizon Ladder": ("时间地平线阶梯", "把这个想法分别解到 1 年后、10 年后、100 年后——记下每一阶上什么活着、什么崩了、什么变得荒唐"),
    "Post-Scarcity Test": ("后稀缺测试", "假定那个核心约束(钱、能源、时间、注意力)现在无限且免费——这个想法会变成什么"),
    "Utopia vs Dystopia Split-Screen": ("乌托邦 vs 反乌托邦分屏", "把同一个未来写两遍:一份是一切完美的宣传册,一份是彻底翻车的头条新闻"),
    "Sci-Fi Artifact From the Future": ("来自未来的科幻造物", "描述一件实物、一则广告或一段新闻片段,来自这个想法已经赢了的那个世界——然后逆向工程它"),
    "Emerging Tech Collision": ("前沿技术对撞", "把你的想法强行嫁给一项前沿技术(AGI、核聚变、神经植入、基因编辑),问会诞生出什么新东西"),
    "What-If-The-World-Changed Card Flip": ("世界剧变卡牌翻转", "抽一张狂野的世界剧变(隐私消失、人口减半、寿命 200 年),重新设计想法去适配那个世界"),
    "Future Anthropologist Dig": ("未来人类学家的挖掘", "2200 年的学者把你的想法当遗迹挖了出来——他们会断定它揭示了我们什么,以及是什么取代了它"),
    "Scenario Cross": ("情景交叉", "挑两个高影响的不确定性,交叉成四种未来,构思那个在每一种未来里都能赢的动作"),
    # deep (tail)
    "TRIZ Contradiction": ("TRIZ 矛盾", "指出核心矛盾(那个只有让别的东西变差才能改善的点),然后头脑风暴如何两者通吃而不是取舍"),
    "Fishbone Diagram": ("鱼骨图", "把问题的主脊分成几类原因(人、流程、工具、环境),再从每根骨头上挖出促成因素"),
    "Build on What Works": ("在有效之处加码", "说出什么已经在成功以及为什么,然后构思如何放大和延伸它,而不是去修那些坏掉的"),
}

# --- exact chrome replacements (applied in order) ------------------------------
CHROME = [
    # <head>/<h1>/sub
    ("<title>BMad Method Brainstorming Selection</title>", "<title>BMad Method 头脑风暴技法编排</title>"),
    ("<h1>BMad Method Brainstorming Selection</h1>", "<h1>BMad Method 头脑风暴技法编排</h1>"),
    (
        "Compose your session, hit <strong>Copy prompt</strong>, and paste it back into the chat to begin.",
        "编排你这次的 session,点<strong>复制指令</strong>,然后粘回聊天里开始。",
    ),
    # theme toggle
    ('aria-label="Toggle dark mode" title="Toggle dark mode"', 'aria-label="切换深色模式" title="切换深色模式"'),
    # composer labels
    ('<span class="glabel">Facilitation</span>', '<span class="glabel">引导模式</span>'),
    ('<span class="glabel">Techniques</span>', '<span class="glabel">技法</span>'),
    ('<span class="glabel">Jump to</span>', '<span class="glabel">跳转到</span>'),
    ('<span class="glabel">Great for</span>', '<span class="glabel">适合场景</span>'),
    # mode buttons — label only; data-mode stays English (feeds "Facilitation mode:")
    ('data-mode="Facilitator">Facilitator<', 'data-mode="Facilitator">纯引导 Facilitator<'),
    ('data-mode="Creative Partner">Creative Partner<', 'data-mode="Creative Partner">创意搭档 Creative Partner<'),
    ('data-mode="Ideate for me">Ideate for me<', 'data-mode="Ideate for me">我来跑 Ideate for me<'),
    # mode hints — JS dict values; keys stay English (state.mode lookup)
    (
        "'A forcing function for your ideas — I prompt and push, but never supply them.'",
        "'把你的想法逼出来的装置 —— 我只提问、只施压,一个想法都不会给你。'",
    ),
    (
        "'We riff together — I facilitate and add ideas too, each logged as yours or mine.'",
        "'我们一起对打 —— 我一边引导一边也扔想法,每条都会标记是你的还是我的。'",
    ),
    (
        "'I run the whole session myself, then show you the result and offer to keep going.'",
        "'我自己把整场跑完,然后把结果给你看,再问你要不要继续。'",
    ),
    # counters
    ('<span class="pill">Picked <b id="pickN">0</b></span>', '<span class="pill">已选 <b id="pickN">0</b></span>'),
    ('<span class="step">Random <button', '<span class="step">随机 <button'),
    ('<span class="step">Invent <button', '<span class="step">发明 <button'),
    ('<span class="step">AI picks <button', '<span class="step">AI 挑选 <button'),
    ("Total 0 &middot; 3&ndash;4 is the sweet spot", "共 0 个 &middot; 3&ndash;4 个最合适"),
    ("'Total ' + total + ' · 3–4 is the sweet spot'", "'共 ' + total + ' 个 · 3–4 个最合适'"),
    # copy button + banners
    ('<button id="copy" type="button">Copy prompt</button>', '<button id="copy" type="button">复制指令</button>'),
    (
        "&#10003; Copied! Now paste it into the chat to start your session.",
        "&#10003; 已复制!粘回聊天里就能开始。",
    ),
    (
        "'✓ Copied! Now paste it into the chat to start your session.'",
        "'✓ 已复制!粘回聊天里就能开始。'",
    ),
    (
        "'⚠ Couldn’t reach the clipboard — copy the text in the box, then paste it into the chat.'",
        "'⚠ 读不到剪贴板 —— 请手动复制框里的文字,再粘回聊天里。'",
    ),
    ("'Copy this, then paste it into the chat:'", "'复制这段,然后粘回聊天里:'"),
    # footer
    ("<footer>BMad Method &middot; Brainstorming</footer>", "<footer>BMad Method &middot; 头脑风暴</footer>"),
]


def _sub_span(doc: str, cls: str, fn) -> str:
    return re.sub(
        rf'(<span class="{cls}">)(.*?)(</span>)',
        lambda m: m.group(1) + fn(html.unescape(m.group(2))) + m.group(3),
        doc,
        flags=re.S,
    )


def _esc(s: str) -> str:
    return html.escape(s, quote=False)


def translate(doc: str) -> tuple[str, list[str]]:
    warn: list[str] = []

    for old, new in CHROME:
        if old not in doc:
            warn.append(f"chrome string not found: {old[:60]!r}")
        doc = doc.replace(old, new)

    # group headers: <h2 class="grouphdr" ...>Title</h2>
    doc = re.sub(
        r'(<h2 class="grouphdr"[^>]*>)(.*?)(</h2>)',
        lambda m: m.group(1) + _esc(GROUPS.get(html.unescape(m.group(2)), html.unescape(m.group(2)))) + m.group(3),
        doc,
        flags=re.S,
    )

    # section headers: <h2>Category<span class="cnt">N</span></h2>
    doc = re.sub(
        r'(<h2>)([^<]*)(<span class="cnt">)',
        lambda m: m.group(1) + _esc(CATS.get(html.unescape(m.group(2)), html.unescape(m.group(2)))) + m.group(3),
        doc,
    )

    # jump chips: <button ... class="chip" data-cat="X" ...>X</button> — data-cat stays English
    doc = re.sub(
        r'(<button type="button" class="chip"[^>]*>)(.*?)(</button>)',
        lambda m: m.group(1) + _esc(CATS.get(html.unescape(m.group(2)), html.unescape(m.group(2)))) + m.group(3),
        doc,
        flags=re.S,
    )

    # goal chips: <button ... class="goal" data-goal="slug">Label</button> — data-goal stays English
    doc = re.sub(
        r'(<button type="button" class="goal"[^>]*>)(.*?)(</button>)',
        lambda m: m.group(1) + _esc(GOALS.get(html.unescape(m.group(2)), html.unescape(m.group(2)))) + m.group(3),
        doc,
        flags=re.S,
    )

    # invent cards (must run before the generic name/desc pass)
    def _invent_n(t: str) -> str:
        m = re.fullmatch(r"✨ Invent a (.+) technique", t)
        return f"✨ 即兴发明一个「{CATS.get(m.group(1), m.group(1))}」技法" if m else t

    def _invent_d(t: str) -> str:
        m = re.fullmatch(r"Make up a brand-new technique on the fly, in the spirit of (.+)", t)
        return f"当场造一个全新的技法,秉持「{CATS.get(m.group(1), m.group(1))}」的精神" if m else t

    seen_n: set[str] = set()

    def _name(t: str) -> str:
        if t.startswith("✨ Invent a"):
            return _invent_n(t)
        if t in TECH:
            seen_n.add(t)
            return _esc(TECH[t][0])
        warn.append(f"untranslated name: {t!r}")
        return _esc(t)

    def _desc(t: str) -> str:
        if t.startswith("Make up a brand-new technique"):
            return _invent_d(t)
        for en, (_, zh) in TECH.items():
            if DESC_BY_EN.get(en) == t:
                return _esc(zh)
        warn.append(f"untranslated desc: {t[:50]!r}")
        return _esc(t)

    doc = _sub_span(doc, "n", _name)
    doc = _sub_span(doc, "d", _desc)

    # "Great for: A · B" affinity line on each card
    def _gf(t: str) -> str:
        if not t.startswith("Great for: "):
            return _esc(t)
        parts = [GOALS.get(p.strip(), p.strip()) for p in t[len("Great for: ") :].split("·")]
        return _esc("适合: " + " · ".join(parts))

    doc = _sub_span(doc, "gf", _gf)

    # totals line
    doc = re.sub(
        r"(\d+) techniques across (\d+) categories\.",
        lambda m: f"共 {m.group(1)} 个技法,{m.group(2)} 个分类。",
        doc,
    )

    missing = set(TECH) - seen_n
    if missing:
        warn.append(f"{len(missing)} catalog names never matched: {sorted(missing)[:5]}")
    return doc, warn


# description lookup, built from the shipped CSV so we match the exact source text
def _load_descs() -> dict[str, str]:
    import csv

    f = ROOT / ".claude/skills/bmad-brainstorming/assets/brain-methods.csv"
    with f.open(encoding="utf-8") as fh:
        return {r["technique_name"]: r["description"] for r in csv.DictReader(fh)}


DESC_BY_EN: dict[str, str] = {}


def main() -> int:
    global DESC_BY_EN
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=SRC)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()

    DESC_BY_EN = _load_descs()
    unknown = set(DESC_BY_EN) - set(TECH)
    if unknown:
        print(f"⚠ catalog has {len(unknown)} technique(s) with no translation: {sorted(unknown)}", file=sys.stderr)

    doc, warn = translate(a.src.read_text(encoding="utf-8"))
    a.out.write_text(doc, encoding="utf-8")

    for w in warn:
        print(f"⚠ {w}", file=sys.stderr)
    print(f"✓ wrote {a.out}  ({len(TECH)} techniques translated, {len(warn)} warning(s))")
    return 1 if warn else 0


if __name__ == "__main__":
    raise SystemExit(main())
