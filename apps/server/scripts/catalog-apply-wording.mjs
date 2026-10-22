import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptableRewrite, searchText } from './catalog-lib.mjs';
import { NAME_LOCKS, normalizeExerciseName, translateExerciseName } from './catalog-glossary.mjs';

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const write = process.argv.includes('--write');
const taxonomy = JSON.parse(readFileSync(join(serverRoot, 'catalog/taxonomy.json'), 'utf8'));

function zhMuscle(token) {
  return taxonomy.muscle[token]?.['zh-CN'] ?? token;
}

const TOOL = {
  assisted: '辅助器械',
  band: '弹力带',
  barbell: '杠铃',
  'body weight': '身体',
  'bosu ball': '身体',
  cable: '把手',
  dumbbell: '哑铃',
  'elliptical machine': '椭圆机',
  'ez barbell': 'EZ杠',
  hammer: '战锤',
  kettlebell: '壶铃',
  landmine: '地雷杠',
  'leverage machine': '手柄',
  macebell: '狼牙棒',
  'medicine ball': '药球',
  'olympic barbell': '杠铃',
  'resistance band': '阻力带',
  roller: '泡沫轴',
  rope: '绳索',
  sandbag: '沙袋',
  'skierg machine': '滑雪机',
  'sled machine': '雪橇',
  'smith machine': '史密斯杠',
  'stability ball': '身体',
  'stationary bike': '健身车',
  'stepmill machine': '登山机',
  'suspension trainer': '悬挂带',
  tire: '轮胎',
  'trap bar': '六角杠',
  'upper body ergometer': '上肢功率车',
  'weight plate': '杠铃片',
  weighted: '负重',
  'wheel roller': '健腹轮',
};

const EQUIP_EN = {
  assisted: 'a helping station',
  band: 'an elastic loop',
  barbell: 'a long bar',
  'body weight': 'body mass alone',
  'bosu ball': 'a dome trainer',
  cable: 'a pulley stack',
  dumbbell: 'handheld weights',
  'elliptical machine': 'an elliptical',
  'ez barbell': 'a cambered bar',
  hammer: 'a hammer tool',
  kettlebell: 'a bell-shaped weight',
  landmine: 'an anchored bar end',
  'leverage machine': 'a lever station',
  macebell: 'a mace',
  'medicine ball': 'a heavy ball',
  'olympic barbell': 'a competition bar',
  'resistance band': 'a stretch band',
  roller: 'a foam cylinder',
  rope: 'a rope handle',
  sandbag: 'a sand-filled bag',
  'skierg machine': 'a ski machine',
  'sled machine': 'a push sled',
  'smith machine': 'a rail-guided bar',
  'stability ball': 'an inflatable sphere',
  'stationary bike': 'a fixed bike',
  'stepmill machine': 'a stair mill',
  'suspension trainer': 'hanging straps',
  tire: 'a large tire',
  'trap bar': 'a hexagonal bar',
  'upper body ergometer': 'an arm crank',
  'weight plate': 'a loose plate',
  weighted: 'added load',
  'wheel roller': 'an ab wheel',
};

const TARGET_EN = {
  abs: 'midsection',
  abdominals: 'midsection',
  abductors: 'outer hips',
  adductors: 'inner thighs',
  ankles: 'ankles',
  biceps: 'elbow flexors',
  brachialis: 'deep elbow flexors',
  calves: 'lower legs',
  'cardiovascular system': 'heart and lungs',
  chest: 'chest',
  core: 'trunk',
  deltoids: 'shoulder caps',
  delts: 'shoulder caps',
  forearm: 'lower arms',
  forearms: 'lower arms',
  gluteal: 'hip extensors',
  glutes: 'hip extensors',
  'grip muscles': 'grip',
  groin: 'groin',
  hamstring: 'rear thighs',
  hamstrings: 'rear thighs',
  'hip flexors': 'hip lifters',
  'inner thighs': 'inner thighs',
  lats: 'side-back pullers',
  'latissimus dorsi': 'side-back pullers',
  'levator scapulae': 'neck-side lifters',
  'lower abs': 'lower trunk',
  'lower back': 'low back',
  obliques: 'waist rotators',
  pectorals: 'chest',
  quadriceps: 'front thighs',
  quads: 'front thighs',
  'rear deltoids': 'rear shoulder caps',
  rhomboids: 'shoulder-blade muscles',
  'rotator cuff': 'shoulder rotators',
  serratus: 'rib-side stabilizers',
  'serratus anterior': 'rib-side stabilizers',
  shins: 'shins',
  soleus: 'deep calf',
  spine: 'spinal muscles',
  traps: 'upper-shoulder lifters',
  trapezius: 'upper-shoulder lifters',
  triceps: 'elbow extensors',
  'upper back': 'upper back',
  'upper chest': 'upper chest',
  'wrist extensors': 'wrist straighteners',
  'wrist flexors': 'wrist benders',
  wrists: 'wrists',
};

function targetEn(token) {
  return TARGET_EN[token] ?? token;
}

export function detectKind(name, category) {
  const text = normalizeExerciseName(name);
  const rules = [
    [/romanian|stiff leg|good morning|\brdl\b/, 'hinge'],
    [/deadlift/, 'hinge'],
    [/leg press/, 'legpress'],
    [/nordic|leg curl|hamstring curl/, 'legcurl'],
    [/leg extension/, 'legext'],
    [/calf raise|calf press|donkey calf|tibialis raise|tib raise/, 'calf'],
    [/face pull/, 'facepull'],
    [/pulldown|pull down/, 'pulldown'],
    [/pull up|chin up|muscle up/, 'pullup'],
    [/push up/, 'pushup'],
    [/pushdown|push down/, 'pushdown'],
    [/bench press|floor press|board press/, 'bench'],
    [/flye?\b|flyes|\bfly\b|crossover/, 'fly'],
    [/lateral raise|front raise|rear delt|y raise|w raise|t raise|lu raise|powell raise/, 'raise'],
    [/kickback/, 'kickback'],
    [/skull|skullcrusher/, 'extend'],
    [/wrist curl|reverse wrist/, 'wrist'],
    [/curl/, 'curl'],
    [/\bsled\b/, 'carry'],
    [/upright row|\brow\b|rowing/, 'row'],
    [/thruster|squat to press/, 'thruster'],
    [/squat/, 'squat'],
    [/lunge|split squat/, 'lunge'],
    [/hip thrust|\bthrust\b/, 'thrust'],
    [/glute bridge|hip bridge|\bbridge\b/, 'bridge'],
    [/hyperextension|back extension|back raise/, 'backext'],
    [/clean and jerk|\bsnatch\b|\bclean\b|\bjerk\b/, 'olympic'],
    [/\bpress\b/, 'press'],
    [/swing/, 'swing'],
    [/shrug/, 'shrug'],
    [/\bplank\b/, 'plank'],
    [/crunch|sit up/, 'crunch'],
    [/twist|wood ?chop|rotation/, 'twist'],
    [/stretch/, 'stretch'],
    [/jump|hop|\bburpee\b|\bjack\b/, 'plyo'],
    [/carry|farmer|yoke|\bwalk\b/, 'carry'],
    [/\bdip\b/, 'dip'],
    [/abduction/, 'abduct'],
    [/adduction/, 'adduct'],
    [/rollout|rollerout|ab wheel/, 'rollout'],
    [/handstand|planche|\bl sit\b|human flag|dragon flag/, 'skill'],
    [/isometric|\bhold\b/, 'iso'],
    [/bike|\bjog\b|\brun\b|elliptical|\bski\b|treadmill|sprint/, 'cardio'],
  ];
  for (const [pattern, kind] of rules) if (pattern.test(text)) return kind;
  const byCategory = {
    yoga: 'yoga',
    stretching: 'stretch',
    mobility: 'mobility',
    pilates: 'pilates',
    plyometrics: 'plyo',
    cardio: 'cardio',
    isometric: 'iso',
    olympic: 'olympic',
    combat: 'combat',
    rehab: 'rehab',
  };
  return byCategory[category] ?? 'general';
}

function trainZh(target, secondary) {
  const main = zhMuscle(target);
  const helpers = [];
  for (const token of secondary ?? []) {
    const label = zhMuscle(token);
    if (!label || label === main || helpers.includes(label)) continue;
    helpers.push(label);
    if (helpers.length === 2) break;
  }
  if (!helpers.length) return `主要练${main}。`;
  return `主要练${main}，${helpers.join('和')}协助。`;
}

function trainEn(target, secondary, variant) {
  const main = targetEn(target);
  const helpers = [];
  for (const token of secondary ?? []) {
    const label = targetEn(token);
    if (!label || label === main || helpers.includes(label)) continue;
    helpers.push(label);
    if (helpers.length === 2) break;
  }
  const extra = helpers.length ? `; the ${helpers.join(' plus ')} assist` : '';
  const lines = [
    `Work stays on the ${main}${extra}.`,
    `The effort belongs to the ${main}${extra}.`,
    `Load the ${main} first${extra}.`,
  ];
  return lines[variant % lines.length];
}

function zhLead(kind, name, tool) {
  const load = tool === '身体' ? '自身重量' : tool;
  const leads = {
    bench: `${name}是仰卧在凳上，把${load}从胸前向上推起再落下。`,
    curl: `${name}是固定上臂，屈肘把${load}弯向肩部再慢慢伸直。`,
    row: `${name}是把${load}拉向腰腹或下胸，再向前送回。`,
    squat: `${name}是屈髋屈膝下蹲，再蹬地站起。`,
    hinge: `${name}是髋部后移再伸髋站直，用后链提起${load}。`,
    lunge: `${name}是前后分腿下蹲，再蹬回站立。`,
    press: `${name}是把${load}向上或向前推起，再控制放回。`,
    pulldown: `${name}是把横杆或把手从高处拉向锁骨或胸口。`,
    pullup: `${name}是双手悬垂，把身体向上拉过握点再放下。`,
    pushup: `${name}是撑地屈肘让胸口下降，再把身体推离地面。`,
    fly: `${name}是双臂张开，再向中线夹拢。`,
    raise: `${name}是手臂向侧方或前方抬到约肩高，再慢慢放下。`,
    legpress: `${name}是用双脚把踏板蹬直，再屈膝还原。`,
    legcurl: `${name}是屈膝把脚跟拉向臀部，再缓慢伸直。`,
    legext: `${name}是把小腿向前踢到膝盖伸直，再慢慢弯回。`,
    calf: `${name}是前脚掌撑地，把脚跟尽量抬高再落下。`,
    thrust: `${name}是上背靠住支撑，把髋部向前上方推起再放下。`,
    bridge: `${name}是把髋部向上抬高，并在顶部收紧臀部。`,
    crunch: `${name}是把胸廓卷向骨盆，缩短腹部后再展开。`,
    twist: `${name}是躯干左右转动，让腰腹在旋转里出力。`,
    plank: `${name}是把身体撑稳并保持住这个形状。`,
    stretch: `${name}是把目标部位缓慢拉长，在有牵拉感的位置停留。`,
    yoga: `${name}是按该体式摆好身体，并稳住呼吸。`,
    plyo: `${name}是快速离地或变向，再尽量稳稳落地。`,
    cardio: `${name}是连续进行、用来抬高心率的练习。`,
    iso: `${name}是在固定角度上静力对抗并保持。`,
    olympic: `${name}是把杠铃快速从低位提到肩上或头顶。`,
    carry: `${name}是握紧负荷并走一段距离。`,
    swing: `${name}是用髋部发力把${load}摆到身前，再接回腿间。`,
    shrug: `${name}是肩胛向上耸起，再主动放下。`,
    dip: `${name}是撑在双杠或凳上屈肘下降，再把身体推起。`,
    pushdown: `${name}是上臂固定，把小臂向下压到肘伸直。`,
    kickback: `${name}是上臂贴住体侧，向后伸直肘关节再弯回。`,
    extend: `${name}是把弯曲的肘推直到伸直，再控制弯回。`,
    wrist: `${name}是前臂放稳，只让手腕上下弯起。`,
    facepull: `${name}是把绳索拉向面部，同时让肩向外转。`,
    abduct: `${name}是把腿或手臂向身体外侧打开，再收回。`,
    adduct: `${name}是把腿或手臂向身体中线收回。`,
    backext: `${name}是把躯干从屈曲抬到与腿接近成线，再慢慢放回。`,
    rollout: `${name}是把轮子向前滚出，再用腹部把身体拉回来。`,
    thruster: `${name}是下蹲站起后，接着把${load}推到头顶。`,
    skill: `${name}是靠全身张力维持形状的自重技巧。`,
    mobility: `${name}是在可控范围内反复活动关节。`,
    pilates: `${name}是配合呼吸、按普拉提轨迹完成的控制练习。`,
    combat: `${name}是按出拳或出腿的轨迹完成的格斗动作。`,
    rehab: `${name}是小幅度、可控制地活动目标部位。`,
    general: `${name}按这个名称对应的轨迹完成每次重复。`,
  };
  return leads[kind] ?? leads.general;
}

function zhSteps(kind, tool, target) {
  const load = tool === '身体' ? '身体' : tool;
  const ready = tool === '身体' ? '先把身体摆到起始姿势。' : `先拿稳${load}，摆到起始姿势。`;
  const focus = `让${target}在用力的那段路程里保持紧张。`;
  const steps = {
    bench: [ready, `把${load}从胸前向上推起，前臂大致垂直。`, '控制落回胸口上方，不要在底部弹起。'],
    curl: [ready, `屈肘把${load}弯向肩部，躯干不要借力晃动。`, '再把肘慢慢伸直，回到起点。'],
    row: [ready, `把${load}拉向腰腹，肩胛往后收。`, '向前送回时手臂伸长，但肩不要耸起。'],
    squat: [
      '双脚踩稳，核心先收住。',
      '髋和膝一起弯曲下蹲，膝盖大致朝脚尖。',
      '整脚蹬地站起，再进行下一次。',
    ],
    hinge: [ready, '髋部向后坐，背部保持中立，膝只微屈。', '用髋把身体拉回直立，不要靠腰甩。'],
    lunge: [
      '前后分腿站好，躯干立住。',
      '后膝向下、前膝弯曲，下到能控制的深度。',
      '前脚蹬回站立，再换边或继续。',
    ],
    press: [ready, `把${load}沿既定方向推出去，手腕保持中立。`, '控制放回起点，再推下一次。'],
    pulldown: [
      '坐稳，把横杆或把手握在肩宽附近。',
      '把把手拉向锁骨或上胸，肘朝身体两侧。',
      '再让手臂回到头顶上方，肩不要完全松掉。',
    ],
    pullup: [
      '双手握住上方的杠，肩先沉下来。',
      '把胸口拉向握点，下到手臂接近伸直。',
      '不要用甩腿来凑次数。',
    ],
    pushup: [
      '双手撑在肩下方，身体从肩到脚成一条线。',
      '屈肘让胸口靠近地面。',
      '再把身体推离地面，髋不要塌。',
    ],
    fly: [ready, `双臂张开到有胸肌牵拉的位置，肘微屈。`, `再把${load}夹回体前中线。`],
    raise: [ready, '手臂抬到大约肩高，身体不要后仰。', '再慢慢放回体侧。'],
    legpress: [
      '背部贴住靠垫，双脚踩在踏板中部。',
      '把踏板蹬出去，膝不要锁死。',
      '再屈膝回到起点。',
    ],
    legcurl: ['把脚踝垫在滚轴后方。', '屈膝把脚跟拉向臀部。', '再缓慢把腿放直。'],
    legext: ['背部贴住靠垫，小腿抵住滚轴。', '把小腿向前踢到膝接近伸直。', '再慢慢弯回来。'],
    calf: ['前脚掌踩稳，膝几乎伸直。', '把脚跟尽量抬高。', '再把脚跟放回低于脚尖的位置。'],
    thrust: [
      '上背靠在凳沿，脚下踩稳。',
      '把髋向上推到躯干和大腿接近成线。',
      '再把髋放回，不要用下背代偿。',
    ],
    bridge: ['仰卧屈膝，双脚踩地。', '把髋抬高，臀部夹紧。', '再把髋放下，保持下一次还能发力。'],
    crunch: ['仰卧，下背轻贴地面。', '把胸口卷向骨盆，下背不要整段抬空。', '再慢慢展开。'],
    twist: [ready, '以胸椎转动躯干，髋尽量少跟着转。', '回到中线，再转向另一侧。'],
    plank: [
      '前臂或双手撑地，身体拉成一条线。',
      `收住${target}，髋不要下塌或撅起。`,
      '保持到计划时间再放下。',
    ],
    stretch: [
      '进入能感到轻微软组织拉长的位置。',
      '呼吸放慢，不要靠弹震加深。',
      '停留到计划时间，再换边或退出。',
    ],
    yoga: ['按体式把关节放进能维持的位置。', '呼吸保持均匀，不要憋气。', '到点后按相反顺序退出。'],
    plyo: [
      '先用一个安静的预备姿势接住重心。',
      '快速离地或变向，落地时用脚和髋接住。',
      '站稳后再开始下一次。',
    ],
    cardio: [
      '按这个动作的节奏开始，先求动作完整。',
      '持续做，让心率逐渐上来。',
      '如果动作变形，就放慢而不是硬撑。',
    ],
    iso: ['进入目标角度。', `对抗${load}并保持，不要屏住呼吸。`, '到点后慢慢松开。'],
    olympic: [
      '杠铃贴近身体，从腿和髋开始发力。',
      '在杠经过大腿后，把身体沉到杠下接住。',
      '站稳后再放下，准备下一次。',
    ],
    carry: [
      `双手握稳${load}，肋骨收住。`,
      '短步走完计划距离，躯干不要左右倒。',
      '放下时先屈髋，不要弓腰扔。',
    ],
    swing: [
      '壶铃或负荷从身前摆回腿间，髋向后。',
      '髋向前伸展，把负荷摆到大约胸口高度。',
      '再用髋接住回摆，手臂只是挂钩。',
    ],
    shrug: [ready, '肩向上耸，脖子不要向前伸。', '再把肩主动放回。'],
    dip: [
      '双手撑在双杠或凳上，肩沉下来。',
      '屈肘把身体降下，肩不要顶到耳朵。',
      '再把身体推起，肘接近伸直。',
    ],
    pushdown: ['上臂夹在体侧。', `把${load}向下压到肘伸直。`, '再让小臂回到大约九十度。'],
    kickback: ['上臂抬到与躯干接近平行并固定。', '向后把肘伸直。', '再只弯小臂回到起点。'],
    extend: [ready, '把肘从弯曲推到伸直，上臂少动。', '再控制弯回。'],
    wrist: ['前臂放在大腿或凳上。', '只弯手腕，把负荷卷起。', '再把腕放回。'],
    facepull: ['面对滑轮，绳在脸的高度。', '把绳拉向眉眼之间，手分开、肩外转。', '再向前送回。'],
    abduct: ['站或坐稳，身体不要侧倾。', '把腿或手臂向外侧打开。', '再收回中线。'],
    adduct: ['从打开的位置开始。', '把腿或手臂向中线收回。', '再控制打开。'],
    backext: [
      '髋部先固定，躯干从屈曲开始。',
      '把胸口抬到和腿接近成一条线。',
      '再慢慢放回，不要靠甩。',
    ],
    rollout: [
      '跪好或站好，双手握住轮子。',
      '把轮子向前滚到还能拉回来的距离。',
      '用腹部把身体拉回。',
    ],
    thruster: [ready, '先下蹲再站起，站直后立刻把负荷推到头顶。', '放回肩部，再进入下一次下蹲。'],
    skill: [
      '先在容易的角度找到全身张力。',
      `保持形状，让${target}持续工作。`,
      '形状一散就下来，不要硬撑到塌掉。',
    ],
    mobility: [
      '在不痛的范围里慢慢走完这个动作。',
      '每个方向都做到自己能控制的尽头。',
      '再回到起点，换边或重复。',
    ],
    pilates: ['先找好中立的骨盆和呼吸。', '动作放小、放准，不要靠惯性。', '做完一次再开始下一次。'],
    combat: [
      '站好格斗步，手保护住脸。',
      '按这个动作的轨迹打出或踢出。',
      '打完立刻收回，再准备下一次。',
    ],
    rehab: ['幅度只做到没有刺痛的范围。', '动作放慢，目标部位出力。', '如果出现锐痛就停。'],
    general: [ready, focus, '再沿原路回到起点，重复到计划次数。'],
  };
  const chosen = steps[kind] ?? steps.general;
  if (!chosen.includes(focus) && chosen.length < 3) chosen.push(focus);
  return chosen.slice(0, 4);
}

function enLead(kind, equip, variant) {
  const bank = {
    bench: [
      `Recline and drive ${equip} away from the chest, then let it return on that same route.`,
      `From a supine setup, press ${equip} upward and accept it again with the chest.`,
    ],
    curl: [
      `Keep the upper arms quiet and fold the elbows so ${equip} rises toward the shoulders.`,
      `Bend only at the elbows to lift ${equip}, then unfold without tossing the torso.`,
    ],
    row: [
      `Draw ${equip} in toward the waist, then let the arms travel forward again.`,
      `Pull ${equip} toward the lower ribs and send it back out along the same path.`,
    ],
    squat: [
      `Sit the hips down between the feet and stand back up through the whole foot.`,
      `Bend at the hips and knees together, then drive back up to tall.`,
    ],
    hinge: [
      `Send the hips backward with a quiet knee bend, then stand by opening the hips.`,
      `Hinge until the rear thighs load, then return to tall without yanking the low back.`,
    ],
    lunge: [
      `Split the feet and drop the back knee, then push back to the start stance.`,
      `Lower into a long stride and stand again off the front foot.`,
    ],
    press: [
      `Send ${equip} away overhead or forward, then bring it back under control.`,
      `Press ${equip} along its path and return it without bouncing at the bottom.`,
    ],
    pulldown: [
      `Pull the handle from overhead toward the upper chest, then let the arms rise again.`,
      `Draw the grip down to collarbone height and return it overhead.`,
    ],
    pullup: [
      `Hang, then pull the chest toward the hands and lower until the arms are long.`,
      `From a dead hang, lift the body to the grip and ease back down.`,
    ],
    pushup: [
      `Brace from shoulders to feet, lower the chest, and press the floor away.`,
      `Bend the elbows to bring the chest down, then push back to the top shape.`,
    ],
    fly: [
      `Open the arms wide with a soft elbow, then close them back in front.`,
      `Arc ${equip} out to the sides and sweep it back to the midline.`,
    ],
    raise: [
      `Lift the arms to about shoulder height and lower them without leaning back.`,
      `Raise ${equip} out to the side or front, then return it beside the body.`,
    ],
    legpress: [
      `Press the platform away with both feet and let the knees bend back in.`,
      `Drive the sled out, then return the knees under control.`,
    ],
    legcurl: [
      `Bend the knees to bring the heels toward the hips, then lengthen the legs again.`,
      `Curl the lower legs in and let them straighten slowly.`,
    ],
    legext: [
      `Straighten the knees against the pad, then bend them back.`,
      `Kick the lower legs forward and return them without slamming the stack.`,
    ],
    calf: [
      `Rise onto the forefeet and lower the heels again.`,
      `Lift the heels as high as they go, then drop them below the toes if the setup allows.`,
    ],
    thrust: [
      `With the upper back supported, push the hips up and lower them again.`,
      `Drive the hips toward the ceiling and set them back down.`,
    ],
    bridge: [
      `Lift the hips off the floor and set them down again.`,
      `Raise the pelvis until the trunk and thighs line up, then lower.`,
    ],
    crunch: [
      `Curl the ribcage toward the pelvis and unroll.`,
      `Shorten the front of the trunk, then lengthen it again.`,
    ],
    twist: [
      `Turn the ribcage from side to side while the hips stay quieter.`,
      `Rotate the trunk one way, come through center, and turn the other way.`,
    ],
    plank: [
      `Hold a rigid shape from shoulders to feet for the planned time.`,
      `Support the body in one long line and keep that shape still.`,
    ],
    stretch: [
      `Ease into a gentle lengthening and stay there while breathing.`,
      `Find a mild pull and hold without bouncing.`,
    ],
    yoga: [
      `Arrange the body in this shape and keep the breath moving.`,
      `Settle into the posture and stay for the planned breaths.`,
    ],
    plyo: [
      `Leave the ground quickly and land ready for the next effort.`,
      `Project the body, then stick the landing before repeating.`,
    ],
    cardio: [
      `Keep the rhythm going so breathing and heart rate climb.`,
      `Repeat the cycle without long pauses.`,
    ],
    iso: [
      `Hold the chosen joint angle and breathe while the muscles stay on.`,
      `Lock in the position and maintain tension for the planned time.`,
    ],
    olympic: [
      `Accelerate the bar from the floor and catch it on the shoulders or overhead.`,
      `Pull the bar close, then drop under it to receive it.`,
    ],
    carry: [
      `Grip the load and walk the planned distance with a tall trunk.`,
      `Carry ${equip} for steps, keeping the ribs stacked over the pelvis.`,
    ],
    swing: [
      `Hike the load back between the legs and project it forward with the hips.`,
      `Swing ${equip} to chest height from a hip snap, then let it return.`,
    ],
    shrug: [
      `Lift the shoulders toward the ears and set them back down.`,
      `Shrug ${equip} up, then lower the shoulders fully.`,
    ],
    dip: [
      `Support yourself on the hands, bend the elbows to descend, and press back up.`,
      `Lower the body between the hands and drive back to straight arms.`,
    ],
    pushdown: [
      `Pin the upper arms and press the forearms down until the elbows open.`,
      `Extend the elbows against ${equip} and let them bend again.`,
    ],
    kickback: [
      `Fix the upper arm and straighten the elbow behind you.`,
      `Kick ${equip} back by opening the elbow, then bend only the forearm.`,
    ],
    extend: [
      `Open the elbow against ${equip} and bend it back.`,
      `Straighten the arm, then return the forearm without moving the shoulder much.`,
    ],
    wrist: [
      `Rest the forearm and curl only the wrist.`,
      `Bend the wrist up and lower it again while the arm stays put.`,
    ],
    facepull: [
      `Pull toward the face and turn the shoulders outward at the end.`,
      `Draw the rope to eye level, separating the hands.`,
    ],
    abduct: [
      `Open the limb away from the midline and bring it back.`,
      `Move out to the side without tipping the trunk, then return.`,
    ],
    adduct: [
      `Draw the limb back toward the midline.`,
      `Close the legs or arms inward, then control the return.`,
    ],
    backext: [
      `Hinge over the pad and lift the trunk until it lines up with the legs.`,
      `Raise the chest from the hanging position and lower it again.`,
    ],
    rollout: [
      `Roll forward only as far as you can pull back, then return.`,
      `Send the wheel out and drag the body back in with the trunk.`,
    ],
    thruster: [
      `Squat, stand, and continue straight into an overhead press.`,
      `Rise from the bottom and drive ${equip} overhead in one sequence.`,
    ],
    skill: [
      `Build tension and hold the shape for as long as it stays clean.`,
      `Find the position, then keep the body tight until the shape breaks.`,
    ],
    mobility: [
      `Move the joint through a comfortable range and come back.`,
      `Explore the end range you can still own, then return.`,
    ],
    pilates: [
      `Move slowly on the breath, keeping the trunk organized.`,
      `Make a small precise path and repeat it.`,
    ],
    combat: [
      `Strike along this path and retract the limb at once.`,
      `Throw the punch or kick, then return the guard.`,
    ],
    rehab: [
      `Use a small pain-free range and stay slow.`,
      `Move only as far as the target area tolerates.`,
    ],
    general: [
      `Move ${equip} along this pattern and return on the same route.`,
      `Complete the path this drill asks for, then reset.`,
    ],
  };
  const lines = bank[kind] ?? bank.general;
  return lines[variant % lines.length];
}

const CUES = {
  bench: 'press',
  curl: 'curl',
  row: 'row',
  squat: 'squat',
  hinge: 'hinge',
  lunge: 'lunge',
  press: 'press',
  pulldown: 'pulldown',
  pullup: 'pull-up',
  pushup: 'push-up',
  fly: 'fly',
  raise: 'raise',
  legpress: 'leg press',
  legcurl: 'leg curl',
  legext: 'leg extension',
  calf: 'heel raise',
  thrust: 'hip thrust',
  bridge: 'bridge',
  crunch: 'curl-up',
  twist: 'twist',
  plank: 'hold',
  stretch: 'stretch',
  yoga: 'posture',
  plyo: 'jump',
  cardio: 'cycle',
  iso: 'hold',
  olympic: 'lift',
  carry: 'carry',
  swing: 'swing',
  shrug: 'shrug',
  dip: 'dip',
  pushdown: 'press-down',
  kickback: 'kickback',
  extend: 'extension',
  wrist: 'wrist curl',
  facepull: 'face pull',
  abduct: 'abduction',
  adduct: 'adduction',
  backext: 'back raise',
  rollout: 'rollout',
  thruster: 'thruster',
  skill: 'hold',
  mobility: 'reach',
  pilates: 'pilates move',
  combat: 'strike',
  rehab: 'rehab move',
  general: 'pattern',
};

function enSteps(kind, equip, target, variant) {
  const cue = CUES[kind] ?? 'pattern';
  const sets = [
    [
      `Set ${equip} so the ${cue} can start from a steady position.`,
      `Perform the ${cue} and keep the ${target} under tension.`,
      `Change direction before the joints bang, then retrace the route.`,
      `Stop when the ${target} are what give out.`,
    ],
    [
      `Arrange ${equip} for the ${cue}.`,
      `Let the ${cue} be the motion, with the ${target} doing the job.`,
      `Own the far point, then come back slower than the way out.`,
      `Keep the repeats smooth enough to feel the ${target}.`,
    ],
    [
      `Take the setup this ${cue} needs.`,
      `Travel through the ${cue} while the ${target} stay involved.`,
      `Reverse before you lose the position.`,
      `Rack or rest only after the ${target} have done the work.`,
    ],
  ];
  return sets[variant % sets.length];
}

function englishRewrite(row) {
  const kind = detectKind(row.data.name, row.movementCategory);
  const equip = EQUIP_EN[row.equipment] ?? 'the load';
  const target = targetEn(row.target);
  const secondary = row.data.secondaryMuscles ?? [];
  const candidates = [];
  for (let variant = 0; variant < 3; variant += 1) {
    for (let stepSet = 0; stepSet < 3; stepSet += 1) {
      candidates.push({
        description: `${enLead(kind, equip, variant)} ${trainEn(row.target, secondary, variant)}`,
        instructions: enSteps(kind, equip, target, stepSet),
      });
    }
  }
  return candidates;
}

function numbered(steps) {
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
}

function loadOriginals() {
  const map = new Map();
  const dir = '/tmp/og-slices';
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const rows = Array.isArray(data) ? data : Object.values(data);
    for (const row of rows) if (row?.id) map.set(String(row.id), row);
  }
  return map;
}

function wordsOf(text) {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function sharedGrams(source, fresh) {
  const grams = (text) => {
    const tokens = wordsOf(text);
    const found = new Set();
    for (let index = 0; index <= tokens.length - 5; index += 1) {
      found.add(tokens.slice(index, index + 5).join(' '));
    }
    return found;
  };
  const left = grams(source);
  const right = grams(fresh);
  const shared = [];
  for (const gram of right) if (left.has(gram)) shared.push(gram);
  return shared;
}

const catalog = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/exercises.normalized.json'), 'utf8'),
);
const originals = loadOriginals();
const existingRewrites = JSON.parse(
  readFileSync(join(serverRoot, 'catalog/rewrites.json'), 'utf8'),
);
const byId = new Map(catalog.exercises.map((row) => [row.id, row]));
const bases = catalog.exercises.filter((row) => !row.data.variantOf);
const unknown = new Map();
const translations = {};
const provenance = {
  method: 'machine',
  reviewed: false,
  tool: 'OpenFitness catalog wording',
};

let rewriteFailures = [];
let rewrittenNow = 0;

for (const row of bases) {
  const translated = translateExerciseName(row.data.name);
  for (const token of translated.unknown) unknown.set(token, (unknown.get(token) ?? 0) + 1);
  const lock = NAME_LOCKS[row.externalId];
  const name = lock?.name ?? translated.name;
  const kind = detectKind(row.data.name, row.movementCategory);
  const tool = TOOL[row.equipment] ?? '负荷';
  const target = zhMuscle(row.target);
  const description = `${zhLead(kind, name, tool)}${trainZh(row.target, row.data.secondaryMuscles)}`;
  const instructions = numbered(zhSteps(kind, tool, target));
  translations[row.externalId] = {
    name,
    aliases: lock?.aliases ?? [],
    description,
    instructions,
    provenance,
  };
  if (!row.needsRewrite) continue;
  const original = originals.get(row.externalId);
  if (!original) {
    rewriteFailures.push({ id: row.externalId, reason: 'missing original' });
    continue;
  }
  const candidates = englishRewrite(row);
  const chosen = candidates.find((candidate) => acceptableRewrite(original, candidate));
  if (!chosen) {
    const sample = candidates[0];
    const source = [original.description ?? '', ...(original.instructions ?? [])].join(' ');
    const fresh = [sample.description, ...sample.instructions].join(' ');
    rewriteFailures.push({
      id: row.externalId,
      name: row.data.name,
      grams: sharedGrams(source, fresh).slice(0, 4),
      description: sample.description,
    });
    continue;
  }
  row.needsRewrite = false;
  row.data.needsRewrite = false;
  row.data.description = chosen.description;
  row.data.instructions = numbered(chosen.instructions);
  row.data.source.needsRewrite = false;
  existingRewrites[row.externalId] = {
    description: chosen.description,
    instructions: chosen.instructions,
  };
  rewrittenNow += 1;
}

for (const row of catalog.exercises) {
  if (!row.data.variantOf) continue;
  const base = byId.get(row.data.variantOf);
  if (!base) throw new Error(`missing base for ${row.id}`);
  translations[row.externalId] = structuredClone(translations[base.externalId]);
  if (!row.needsRewrite) continue;
  row.needsRewrite = false;
  row.data.needsRewrite = false;
  row.data.description = base.data.description;
  row.data.instructions = base.data.instructions;
  row.data.source.needsRewrite = false;
}

const pending = catalog.exercises.filter((row) => row.needsRewrite);
const opengym = catalog.exercises.filter((row) => row.source === 'opengym');
catalog.counts.pending = pending.length;
catalog.counts.rewritten = opengym.length - pending.length;
catalog.counts.rejectedRewrites = rewriteFailures.length;

const latin = [];
for (const [id, entry] of Object.entries(translations)) {
  const stripped = entry.name.replace(/BOSU|EZ|JM|PVC|GHR|SZ/g, '');
  if (/[a-z]{3,}/.test(stripped)) latin.push(`${id} ${entry.name}`);
}

const random = rng(20261021);
const samplePool = [...bases];
const samples = [];
for (let index = 0; index < 10 && samplePool.length; index += 1) {
  const pick = Math.floor(random() * samplePool.length);
  const row = samplePool.splice(pick, 1)[0];
  const entry = translations[row.externalId];
  samples.push(`${row.data.name} -> ${entry.name} | ${entry.description}`);
}

console.log(
  JSON.stringify(
    {
      bases: bases.length,
      unknown: unknown.size,
      rewriteFailures: rewriteFailures.length,
      rewrittenNow,
      pending: pending.length,
      rewritten: catalog.counts.rewritten,
      latin: latin.length,
    },
    null,
    2,
  ),
);
if (unknown.size) {
  console.log(
    'unknown',
    [...unknown.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([token, count]) => `${token}:${count}`)
      .join(' '),
  );
}
if (rewriteFailures.length) {
  console.log('rewrite sample');
  for (const failure of rewriteFailures.slice(0, 12)) console.log(JSON.stringify(failure));
}
if (latin.length) console.log('latin', latin.slice(0, 20).join('\n'));
console.log('samples');
for (const line of samples) console.log(line);

if (!write) {
  console.log('report only');
  process.exit(unknown.size || rewriteFailures.length || pending.length || latin.length ? 1 : 0);
}
if (unknown.size || rewriteFailures.length || pending.length || latin.length) {
  console.error('refusing to write incomplete wording');
  process.exit(1);
}

writeFileSync(join(serverRoot, 'catalog/exercises.normalized.json'), JSON.stringify(catalog));
writeFileSync(
  join(serverRoot, 'catalog/rewrites.json'),
  `${JSON.stringify(existingRewrites, null, 2)}\n`,
);
const ordered = {};
for (const row of catalog.exercises) ordered[row.externalId] = translations[row.externalId];
writeFileSync(
  join(serverRoot, 'catalog/exercise-i18n.zh-CN.json'),
  `${JSON.stringify(ordered, null, 2)}\n`,
);

const fixtureIds = [
  '0001',
  '0002',
  '0004',
  '0007',
  '0009',
  '0015',
  '0017',
  '0025',
  '0026',
  '0032',
  '0043',
  '0501',
  '0652',
  '0662',
  '10003',
  '10534',
  '0136',
  '1197',
  '2476',
  '3094',
  '5266',
];
const fixtureRows = catalog.exercises.filter((row) => fixtureIds.includes(row.externalId));
const fixture = {
  exercises: fixtureRows.map((row) => ({
    ...row,
    searchText: searchText(
      {
        name: row.data.name,
        bodyPart: row.bodyPart,
        equipment: row.equipment,
        target: row.target,
        secondaryMuscles: row.data.secondaryMuscles,
        movementCategory: row.movementCategory,
      },
      translations[row.externalId],
    ),
  })),
  i18n: fixtureIds.map((id) => ({
    exerciseId: `cat-${id}`,
    locale: 'zh-CN',
    name: translations[id].name,
    aliases: translations[id].aliases,
    description: translations[id].description,
    instructions: translations[id].instructions,
    provenance: translations[id].provenance,
  })),
};
writeFileSync(
  join(serverRoot, 'tests/fixtures/catalog-exercises.json'),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
console.log('wrote catalogue wording');

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
