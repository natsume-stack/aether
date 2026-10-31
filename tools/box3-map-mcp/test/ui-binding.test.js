/**
 * ui-binding.test.js — lane C gate tests (plan/N7 决策 2, 验收口径 C 行).
 *
 * Every rule in BINDING_RULES gets one positive and at least one negative case,
 * so "反例真的变红" is checked rather than claimed. Two tests are the load-bearing
 * regression for the red line:
 *   - the validator never mutates its input (deep-frozen real tree + byte-for-byte
 *     JSON comparison before/after);
 *   - the real 61-node production uiTree and its real client script validate
 *     CLEAN, which is what proves the gate has no false positives against existing
 *     maps (notably `remoteChannel.events.on('client', …)`, which is NOT a UiEvent
 *     and must not be reported as one).
 *
 * Run: node --test test/*.test.js   (a directory argument does not work on this host)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BINDING_RULES,
  POINTER_EVENT_BEHAVIOR_MEMBERS,
  POINTER_EVENT_BEHAVIOR_VALUES,
  UI_EVENT_NAMES,
  normalizeUiTree,
  scanScriptBindings,
  stripComments,
  validateUiBindings,
} from '../src/ui-binding.js'

// ---------------------------------------------------------------- fixtures

/** The verbatim on-disk uiTree blob of a real production map (61 nodes). */
const REAL_UI_TREE_RAW = "{\"100207687_132055051\":{\"childrenIds\":[],\"id\":\"100207687_132055051\",\"name\":\"choosecase\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/b.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-184,0],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[48,46],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_137319640\":{\"childrenIds\":[\"353324403\"],\"id\":\"100207687_137319640\",\"name\":\"chestItem\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":0,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-123.3984375,-97],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":4},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_264471927\":{\"childrenIds\":[],\"id\":\"100207687_264471927\",\"name\":\"shopImage\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/DM_20240824225100_001.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[300,377],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":3},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_393251795\":{\"childrenIds\":[],\"id\":\"100207687_393251795\",\"name\":\"inventoryImage\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/inventoryImage.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[300,283],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":3},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_396832708\":{\"childrenIds\":[],\"id\":\"100207687_396832708\",\"name\":\"hunger_bar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/hunger_bar.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[100,-59],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[162,18],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_435829821\":{\"childrenIds\":[],\"id\":\"100207687_435829821\",\"name\":\"quickinventorybar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/a.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[364,44],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":0},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_490113038\":{\"childrenIds\":[],\"id\":\"100207687_490113038\",\"name\":\"inventorycase\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/choosecase.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-123.3984375,15.1015625],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[38,36],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":6},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_509227291\":{\"childrenIds\":[],\"id\":\"100207687_509227291\",\"name\":\"expbar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/exp_bar.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,-48],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[364,10],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":0},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_526660562\":{\"childrenIds\":[\"538047081\",\"1057463364\",\"57111004\"],\"id\":\"100207687_526660562\",\"name\":\"shopItem\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-93,-144],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":4},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_558230863\":{\"childrenIds\":[\"6778413\"],\"id\":\"100207687_558230863\",\"name\":\"invItem\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":0,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-123.3984375,15.1015625],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":4},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_747407169\":{\"childrenIds\":[],\"id\":\"100207687_747407169\",\"name\":\"chestImage\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/chestImage.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[300,283],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":3},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_774347377\":{\"childrenIds\":[],\"id\":\"100207687_774347377\",\"name\":\"health_bar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/health_bar21.png\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-100,-59],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[162,18],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_888055948\":{\"childrenIds\":[],\"id\":\"100207687_888055948\",\"name\":\"extra_hp_bar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":0,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-100,-59],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[162,38],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_973968324\":{\"childrenIds\":[\"83112763\"],\"id\":\"100207687_973968324\",\"name\":\"quickItem\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":0,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-160,-7],\"ratio\":[0.5,1]},\"rotation\":0,\"size\":{\"offset\":[30,30],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"100207687_DEFAULT_SCREEN_ID\":{\"childrenIds\":[\"900503231\",\"629702159\",\"190080564\",\"367827770\",\"169219682\",\"996355324\",\"100207687_264471927\",\"100207687_774347377\",\"100207687_888055948\",\"100207687_396832708\",\"100207687_509227291\",\"635456996\",\"855223886\",\"100207687_526660562\",\"100207687_558230863\",\"100207687_137319640\",\"459108283\",\"160304790\",\"100207687_393251795\",\"100207687_747407169\",\"100207687_973968324\",\"100207687_490113038\",\"100207687_132055051\",\"100207687_435829821\"],\"id\":\"100207687_DEFAULT_SCREEN_ID\",\"name\":\"screen\",\"parentId\":\"ROOT_ID\",\"type\":2,\"value\":{\"data\":{\"enable\":true,\"layout\":{\"data\":null,\"type\":\"none\"},\"zIndex\":1},\"type\":\"screen\"}},\"1057463364\":{\"childrenIds\":[],\"id\":\"1057463364\",\"name\":\"priceType\",\"parentId\":\"100207687_526660562\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":1,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0,0]},\"rotation\":0,\"size\":{\"offset\":[10,10],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"154395951\":{\"childrenIds\":[],\"id\":\"154395951\",\"name\":\"redNum\",\"parentId\":\"772155591\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[110,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"158156813\":{\"childrenIds\":[],\"id\":\"158156813\",\"name\":\"yellowbed\",\"parentId\":\"694600824\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[85,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"158188644\":{\"childrenIds\":[],\"id\":\"158188644\",\"name\":\"breakBeds\",\"parentId\":\"953656174\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[5,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[0,255,0],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":0,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"160304790\":{\"childrenIds\":[],\"id\":\"160304790\",\"name\":\"armor\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-123.3984375,-114],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":4},\"type\":\"image\"},\"type\":\"element\"}},\"169219682\":{\"childrenIds\":[],\"id\":\"169219682\",\"name\":\"cameraButton\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/telescope.png\",\"imageDisplayMode\":0,\"imageOpacity\":0.5,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[70,10],\"ratio\":[0,0]},\"rotation\":0,\"size\":{\"offset\":[50,50],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"190080564\":{\"childrenIds\":[],\"id\":\"190080564\",\"name\":\"bagButton\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/ChristmasChest.png\",\"imageDisplayMode\":0,\"imageOpacity\":0.5,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[10,70],\"ratio\":[0,0]},\"rotation\":0,\"size\":{\"offset\":[50,50],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":3},\"type\":\"image\"},\"type\":\"element\"}},\"196578211\":{\"childrenIds\":[],\"id\":\"196578211\",\"name\":\"G\",\"parentId\":\"323903158\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[30,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"绿队：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"211625212\":{\"childrenIds\":[],\"id\":\"211625212\",\"name\":\"blueNum\",\"parentId\":\"618390450\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[110,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"219859854\":{\"childrenIds\":[],\"id\":\"219859854\",\"name\":\"B\",\"parentId\":\"618390450\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[30,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"蓝队：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"229742469\":{\"childrenIds\":[],\"id\":\"229742469\",\"name\":\"title\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,5],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[247,255,0],\"textContent\":\"起床战争\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":0,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"25407013\":{\"childrenIds\":[],\"id\":\"25407013\",\"name\":\"date\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,30],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[194,194,194],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"285888111\":{\"childrenIds\":[],\"id\":\"285888111\",\"name\":\"greenbed\",\"parentId\":\"323903158\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[85,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"3079413\":{\"childrenIds\":[],\"id\":\"3079413\",\"name\":\"R\",\"parentId\":\"772155591\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[30,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"红队：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"323903158\":{\"childrenIds\":[\"196578211\",\"573048178\",\"285888111\"],\"id\":\"323903158\",\"name\":\"GREEN\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,115],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[0,255,0],\"textContent\":\"绿\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"330884468\":{\"childrenIds\":[],\"id\":\"330884468\",\"name\":\"Y\",\"parentId\":\"694600824\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[30,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"黄队：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"353324403\":{\"childrenIds\":[],\"id\":\"353324403\",\"name\":\"chestNum\",\"parentId\":\"100207687_137319640\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,2],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"1\",\"textFontFamily\":0,\"textFontSize\":0,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":2,\"textYAlignment\":2,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"354657472\":{\"childrenIds\":[],\"id\":\"354657472\",\"name\":\"kills\",\"parentId\":\"881404489\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[75,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[0,255,0],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"367827770\":{\"childrenIds\":[],\"id\":\"367827770\",\"name\":\"settingsButton\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/clock.png\",\"imageDisplayMode\":0,\"imageOpacity\":0.5,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[10,10],\"ratio\":[0,0]},\"rotation\":0,\"size\":{\"offset\":[50,50],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"image\"},\"type\":\"element\"}},\"459108283\":{\"childrenIds\":[\"563725674\"],\"id\":\"459108283\",\"name\":\"invQuickItem\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"\",\"imageDisplayMode\":0,\"imageOpacity\":1,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[-123.3984375,114.5],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"visible\":false,\"zIndex\":4},\"type\":\"image\"},\"type\":\"element\"}},\"538047081\":{\"childrenIds\":[],\"id\":\"538047081\",\"name\":\"priceNum\",\"parentId\":\"100207687_526660562\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.349609375,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":10,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":1,\"textYAlignment\":1,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"563725674\":{\"childrenIds\":[],\"id\":\"563725674\",\"name\":\"invQuickNum\",\"parentId\":\"459108283\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,2],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":17,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":2,\"textYAlignment\":2,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"57111004\":{\"childrenIds\":[],\"id\":\"57111004\",\"name\":\"shopNum\",\"parentId\":\"100207687_526660562\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,2],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":16,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":2,\"textYAlignment\":2,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"573048178\":{\"childrenIds\":[],\"id\":\"573048178\",\"name\":\"greenNum\",\"parentId\":\"323903158\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[110,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"589129512\":{\"childrenIds\":[],\"id\":\"589129512\",\"name\":\"bluebed\",\"parentId\":\"618390450\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[85,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"608823039\":{\"childrenIds\":[],\"id\":\"608823039\",\"name\":\"redbed\",\"parentId\":\"772155591\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[85,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"618390450\":{\"childrenIds\":[\"219859854\",\"211625212\",\"589129512\"],\"id\":\"618390450\",\"name\":\"BLUE\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,90],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[0,0,255],\"textContent\":\"蓝\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"629702159\":{\"childrenIds\":[],\"id\":\"629702159\",\"name\":\"inputBox\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[0,0,0],\"backgroundOpacity\":0.5,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"placeholder\":\"\",\"placeholderColor\":[255,255,255],\"placeholderOpacity\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0,1]},\"rotation\":0,\"size\":{\"offset\":[0,25],\"ratio\":[1,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":19,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":false,\"zIndex\":1},\"type\":\"input\"},\"type\":\"element\"}},\"635456996\":{\"childrenIds\":[],\"id\":\"635456996\",\"name\":\"shadow\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/shadow.png\",\"imageDisplayMode\":0,\"imageOpacity\":0.5,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,0.5]},\"rotation\":0,\"size\":{\"offset\":[200,200],\"ratio\":[1,1]},\"visible\":false,\"zIndex\":2},\"type\":\"image\"},\"type\":\"element\"}},\"676089036\":{\"childrenIds\":[\"89737509\"],\"id\":\"676089036\",\"name\":\"FINALKILL\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,200],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"最终击杀数:\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"6778413\":{\"childrenIds\":[],\"id\":\"6778413\",\"name\":\"invNum\",\"parentId\":\"100207687_558230863\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,2],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[28,28],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":16,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":2,\"textYAlignment\":2,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"694600824\":{\"childrenIds\":[\"330884468\",\"736565022\",\"158156813\"],\"id\":\"694600824\",\"name\":\"YELLOW\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,140],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,0],\"textContent\":\"黄\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"736565022\":{\"childrenIds\":[],\"id\":\"736565022\",\"name\":\"yellowNum\",\"parentId\":\"694600824\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[110,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"772155591\":{\"childrenIds\":[\"3079413\",\"154395951\",\"608823039\"],\"id\":\"772155591\",\"name\":\"RED\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,65],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,0,0],\"textContent\":\"红\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"83112763\":{\"childrenIds\":[],\"id\":\"83112763\",\"name\":\"quickNum\",\"parentId\":\"100207687_973968324\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,3],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[30,30],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"1\",\"textFontFamily\":0,\"textFontSize\":0,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":1,\"textXAlignment\":2,\"textYAlignment\":2,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"855223886\":{\"childrenIds\":[\"893786656\",\"953656174\",\"676089036\",\"881404489\",\"950239508\",\"618390450\",\"323903158\",\"694600824\",\"772155591\",\"25407013\",\"229742469\"],\"id\":\"855223886\",\"name\":\"sidebar\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[1,0.5],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"image\":\"picture/shadow.png\",\"imageDisplayMode\":0,\"imageOpacity\":0.5,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[1,0.5]},\"rotation\":0,\"size\":{\"offset\":[200,285],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":2},\"type\":\"image\"},\"type\":\"element\"}},\"855959407\":{\"childrenIds\":[],\"id\":\"855959407\",\"name\":\"titleContent\",\"parentId\":\"900503231\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,400],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[0,20],\"ratio\":[1,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":15,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"880909089\":{\"childrenIds\":[],\"id\":\"880909089\",\"name\":\"msgContent\",\"parentId\":\"900503231\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[0,0,0],\"backgroundOpacity\":0.5,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,400],\"ratio\":[0,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[0,20],\"ratio\":[1,0]},\"textColor\":[255,255,255],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":15,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":false,\"zIndex\":0},\"type\":\"text\"},\"type\":\"element\"}},\"881404489\":{\"childrenIds\":[\"354657472\"],\"id\":\"881404489\",\"name\":\"KILL\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,175],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"击杀数：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"893786656\":{\"childrenIds\":[],\"id\":\"893786656\",\"name\":\"YOU\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[140,65],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[194,194,194],\"textContent\":\"你\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"89737509\":{\"childrenIds\":[],\"id\":\"89737509\",\"name\":\"finalkills\",\"parentId\":\"676089036\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[110,0],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[0,255,0],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"900503231\":{\"childrenIds\":[\"855959407\",\"880909089\"],\"id\":\"900503231\",\"name\":\"scrollBox\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":true,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,-80],\"ratio\":[0,1]},\"rotation\":0,\"scrollCanvasAutoResize\":0,\"scrollCanvasSize\":{\"offset\":[0,400],\"ratio\":[1,0]},\"scrollDirection\":1,\"scrollPosition\":[0,0],\"scrollbarColor\":[153,153,153],\"scrollbarHorizontal\":1,\"scrollbarOpacity\":1,\"scrollbarThickness\":8,\"scrollbarVertical\":1,\"scrollbarVisibility\":0,\"size\":{\"offset\":[650,400],\"ratio\":[0,0]},\"visible\":true,\"zIndex\":1},\"type\":\"scrollBox\"},\"type\":\"element\"}},\"950239508\":{\"childrenIds\":[],\"id\":\"950239508\",\"name\":\"web\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0,1],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0,1]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[247,255,0],\"textContent\":\"Create Better\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[0,0,0],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":0,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"953656174\":{\"childrenIds\":[\"158188644\"],\"id\":\"953656174\",\"name\":\"BED\",\"parentId\":\"855223886\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,225],\"ratio\":[0.5,0]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,20],\"ratio\":[0,0]},\"textColor\":[255,255,255],\"textContent\":\"破坏床数：\",\"textFontFamily\":0,\"textFontSize\":20,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":1,\"textYAlignment\":0,\"visible\":true,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"996355324\":{\"childrenIds\":[],\"id\":\"996355324\",\"name\":\"text\",\"parentId\":\"100207687_DEFAULT_SCREEN_ID\",\"type\":2,\"value\":{\"data\":{\"data\":{\"anchor\":[0.5,0.5],\"autoResize\":0,\"autoWordWrap\":false,\"backgroundColor\":[255,255,255],\"backgroundOpacity\":0,\"clipsDescendants\":false,\"layout\":{\"data\":null,\"type\":\"none\"},\"layoutOrder\":1,\"position\":{\"offset\":[0,0],\"ratio\":[0.5,0.5]},\"richText\":false,\"rotation\":0,\"size\":{\"offset\":[200,50],\"ratio\":[0,0]},\"textColor\":[255,0,0],\"textContent\":\"\",\"textFontFamily\":0,\"textFontSize\":100,\"textLineHeight\":1.19921875,\"textOpacity\":1,\"textStrokeColor\":[255,255,255],\"textStrokeOpacity\":1,\"textStrokeThickness\":0,\"textXAlignment\":0,\"textYAlignment\":0,\"visible\":false,\"zIndex\":1},\"type\":\"text\"},\"type\":\"element\"}},\"ROOT_ID\":{\"childrenIds\":[\"100207687_DEFAULT_SCREEN_ID\"],\"id\":\"ROOT_ID\",\"name\":\"Root\",\"parentId\":\"\",\"type\":0}}";
const REAL_UI_TREE = JSON.parse(REAL_UI_TREE_RAW)

/** The content-addressed blob names those two bytes live under on disk. */
const REAL_UI_TREE_BLOB_NAME = "QmeE9eD83rdVnKzFrkUEinvmBxfPnzP81Pf7uAUCJHFNhV"
const REAL_CLIENT_SCRIPT_BLOB_NAME = "QmVHQfvSjhY6dQdn31xXpou24BXXRrJHcHgsG6j8hmymYd"

/** The verbatim client entry script of that same map (contains the remoteChannel trap). */
const REAL_CLIENT_SCRIPT = "import { ColorList } from \"./cilentConfig.js\";\n\nvar load = false;\n\nconst bagButton = ui.findChildByName('bagButton');\nconst cameraButton = ui.findChildByName('cameraButton');\nconst sideBar = ui.findChildByName('sidebar');\n\n/**设置快捷栏选择框 */\nconst chooseCase = ui.findChildByName(\"choosecase\");\n\nvar setChooseCase = function (pos) {\n    chooseCase.position.offset.x = 40 * pos - 184;\n};\n\n/**设置快捷栏UI */\nconst quickItem = ui.findChildByName('quickItem');\nvar quickItemList = [];\nvar quickNumList = [];\n\nvar setSingleQI = function (index, image, number) {\n    quickNumList[index].textFontSize = number == 1 ? 0 : 17;\n    quickNumList[index].textContent = number.toString()\n    quickItemList[index].imageOpacity = image == '' ? 0 : 1\n    if (image != '') quickItemList[index].image = `picture/${image}.png`;\n};\n\nvar setAllQI = function (playerInventory) {\n    for (let i = 0; i < quickItemList.length; i++) {\n        setSingleQI(i, playerInventory[i][0], playerInventory[i][1])\n    }\n};\n\n/**聊天栏 */\nconst MSGLength = 20;\nvar messages = []\nvar msgColors = []\nvar showMsgNum = 0;\nvar ableScroll = false;\n\nconst scrollBox = ui.findChildByName('scrollBox');\nconst msgContent = scrollBox.findChildByName('msgContent');\nconst titleContent = scrollBox.findChildByName('titleContent');\nvar contentList = []\nvar titleList = []\n\n/**聊天 */\nvar message = function (content, titleLength, titleColor) {\n    const text = content.length > 43 ? [content.slice(0, 43), `   ${content.slice(43, Math.min(content.length, 86))}`] : [content]\n    for (let i = 0; i < text.length; i++) {\n        messages.unshift(text[i])\n        msgColors.unshift(i == 0 ? [titleLength].concat(titleColor) : [0, 'White', 0])\n    }\n    showMsgNum += text.length;\n    for (let i = 0; i < Math.min(messages.length, MSGLength); i++) {\n        const vis = ableScroll || (!ableScroll && i < showMsgNum && i < 10)\n        contentList[i].visible = vis;\n        titleList[i].visible = vis;\n        contentList[i].textContent = msgColors[i][0] > 0 ? `  ${' '.repeat(msgColors[i][2])}${messages[i].slice(msgColors[i][0])}` : messages[i];\n        titleList[i].textContent = msgColors[i][0] > 0 ? messages[i].slice(0, msgColors[i][0]) : ''\n        titleList[i].textColor.copy(titleList[i].textContent == '' ? Vec3.create(ColorList['White']) : Vec3.create(ColorList[msgColors[i][1]]))\n    }\n    setTimeout(() => {\n        for (let i = messages.length - 1; i >= 0; i--) {\n            if (messages[i] == text[0] && showMsgNum == i + 1) {\n                if (ableScroll === undefined || !ableScroll) {\n                    for (let j = 0; j < text.length; j++) {\n                        if (i - j >= 10) continue;\n                        contentList[i - j].visible = false;\n                        titleList[i - j].visible = false;\n                    };\n                    messages = messages.slice(0, Math.max(showMsgNum, MSGLength));\n                };\n                showMsgNum -= text.length;\n                break;\n            }\n        }\n    }, 10000);\n}\n\n/**输入框 */\nconst inputBox = ui.findChildByName('inputBox');\ninputBox.events.add('blur', () => {\n    remoteChannel.sendServerEvent({ type: 'chat', args: { text: inputBox.textContent } });\n    inputBox.textContent = '';\n    inputBox.visible = false;\n    input.lockPointer();\n})\n\n/**滚动框 */\ninput.pointerLockEvents.add(\"pointerlockchange\", ({ isLocked }) => {\n    if (isLocked) {\n        ableScroll = false;\n        scrollBox.scrollPosition.y = 200;\n        scrollBox.size.offset.y = 400;\n        for (let i = Math.min(messages.length, MSGLength) - 1; i >= 10; i--) {\n            contentList[i].visible = false;\n            titleList[i].visible = false;\n        }\n        for (let i = 10; i >= 0; i--) {\n            if (showMsgNum < i + 1) {\n                contentList[i].visible = false;\n                titleList[i].visible = false;\n            }\n        }\n    } else if (!isLocked) {\n        if (messages.length > 10) {\n            ableScroll = true;\n            scrollBox.size.offset.y = 200;\n            scrollBox.scrollPosition.y = 200;\n        }\n        for (let i = 0; i < Math.min(messages.length, MSGLength); i++) {\n            contentList[i].visible = true;\n            titleList[i].visible = true;\n        }\n    }\n});\n\nremoteChannel.events.on('client', event => {// 客户端监听\n    if (!load && event.type !== 'draw') return;\n    switch (event.type) {\n        case 'draw':\n            bagButton.visible = false;\n            cameraButton.visible = false;\n            sideBar.visible = false;\n\n            /**快捷栏 */\n            for (let i = 0; i < 9; i++) {\n                let quickItem_ = quickItem.clone()\n                quickItemList.push(quickItem_)\n                quickItem_.position.offset.x += 40 * i\n                quickNumList.push(quickItem_.findChildByName('quickNum'))\n                quickItem_.findChildByName('quickNum').pointerEventBehavior = PointerEventBehavior.BLOCK_PASS_THROUGH\n                quickItem_.findChildByName('quickNum').events.on('pointerdown', () => {\n                    remoteChannel.sendServerEvent({ type: 'pressQIbyScreen', args: { index: quickNumList.indexOf(quickItem_.findChildByName('quickNum')) } });\n                })\n            };\n\n            /**聊天栏 */\n            for (let i = 0; i < MSGLength; i++) {\n                let msg = msgContent.clone();\n                let title = titleContent.clone();\n                contentList.push(msg);\n                titleList.push(title);\n                msg.position.offset.y -= i * 20;\n                title.position.offset.y -= i * 20;\n            }\n\n            load = true;\n        case 'setChooseCase':\n            setChooseCase(...Object.values(event.args));\n            break;\n        case 'setSingleQI':\n            setSingleQI(...Object.values(event.args));\n            break;\n        case 'setAllQI':\n            setAllQI(...Object.values(event.args));\n            break;\n        case 'message':\n            message(...Object.values(event.args))\n            break;\n        case 'input':\n            inputBox.visible = true;\n            input.unlockPointer();\n            inputBox.focus();\n            break;\n        default:\n            break;\n    }\n});"

/**
 * Real-map location, for the "embedded fixture is still the real bytes" check.
 * Override with BOX3_REAL_MAP_PROJECT when the tree lives elsewhere; the test
 * skips (never silently passes) when absent.
 */
const REAL_MAP_ROOT = process.env.BOX3_REAL_MAP_PROJECT || 'D:/desktop/神奇代码岛/box3-re/tmp/h1-bp/projects/cloud-4e84ee7ef626058f'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const codesOf = (result) => new Set(result.problems.map((item) => item.code))
const only = (result, code) => result.problems.filter((item) => item.code === code)

function node(id, name, parentId, kind) {
  return {
    id,
    name,
    parentId,
    childrenIds: kind ? [] : [String(Number(id) + 1000)] ,
    value: kind ? { type: 'element', data: { type: kind, data: { visible: true } } } : { type: 'screen', data: { zIndex: 1, enable: true } },
  }
}

/** A tiny but schema-shaped tree: screen > (button box, label text, input, image). */
function sampleTree() {
  return {
    nodes: [
      { id: 'ROOT_ID', name: 'Root', parentId: '', childrenIds: ['SCREEN'], value: undefined },
      node('SCREEN', 'screen', 'ROOT_ID', null),
      node('1', 'bagButton', 'SCREEN', 'box'),
      node('2', 'score', 'SCREEN', 'text'),
      node('3', 'inputBox', 'SCREEN', 'input'),
      node('4', 'avatar', 'SCREEN', 'image'),
    ],
  }
}

/** The same tree in the shape MCP's ui_tree_read hands back ({nodes:[…]}) is what
 *  sampleTree already is; persistedMapTree() gives the on-disk id→node map shape. */
function persistedMapTree() {
  const map = {}
  for (const item of sampleTree().nodes) map[item.id] = item
  return map
}

const client = (entry, content) => ({ side: 'client', entry, content })

// ---------------------------------------------------------------- contract shape

test('错误契约：每条问题都带 {code, retryable, hint} 且类型正确', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const x = ui.findChildByName('ghost'); x.events.on('click', () => {}); x.pointerEventBehavior = PointerEventBehavior.HOVER;")],
  })
  assert.ok(bad.problems.length >= 3)
  for (const item of bad.problems) {
    assert.equal(typeof item.code, 'string', 'code 必须是稳定机器 token')
    assert.equal(typeof item.retryable, 'boolean', 'retryable 必须是布尔')
    assert.equal(typeof item.hint, 'string', 'hint 必须是具体下一步')
    assert.ok(item.hint.length > 8, `hint 不能是空话：${item.hint}`)
    assert.ok(['error', 'warning'].includes(item.severity))
  }
})

test('R1 正例：形状合法的输入不报 UI_BINDING_INPUT_INVALID', () => {
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', "ui.findChildByName('bagButton').events.on('pointerdown', () => {});")] })
  assert.equal(only(ok, 'UI_BINDING_INPUT_INVALID').length, 0)
  assert.equal(ok.ok, true)
})

test('R1 反例：缺 uiTree / scripts 类型错 → error 且 retryable=false（原样重跑永远不会好）', () => {
  const cases = [
    { label: '无输入', input: {} },
    { label: 'scripts 是字符串', input: { uiTree: sampleTree(), scripts: 'index.js' } },
    { label: 'bindings 是对象', input: { uiTree: sampleTree(), bindings: { event: 'pointerdown' } } },
  ]
  for (const { label, input } of cases) {
    const result = validateUiBindings(input)
    const hits = only(result, 'UI_BINDING_INPUT_INVALID')
    assert.ok(hits.length >= 1, `${label} 应该报 UI_BINDING_INPUT_INVALID`)
    assert.equal(hits[0].retryable, false, `${label}：修不好输入的调用不该被重试`)
    assert.equal(result.ok, false, `${label}：输入不成形不能算通过`)
  }
})

test('R1 反例：三种 uiTree 形状都能吃（数组 / {nodes} / 盘上 id→node 映射）', () => {
  const asArray = sampleTree().nodes
  const asNodes = sampleTree()
  const asMap = persistedMapTree()
  for (const tree of [asArray, asNodes, asMap]) {
    const result = validateUiBindings({ uiTree: tree, scripts: [client('index.js', "ui.findChildByName('inputBox').events.on('blur', () => {});")] })
    assert.deepEqual(only(result, 'UI_BINDING_INPUT_INVALID'), [], '同一棵树的不同形状不该改变判定')
    assert.equal(result.checked.nodes, 6)
  }
})

test('normalizeUiTree：同时认引擎 RDA 形状和 MCP add-payload 形状', () => {
  const rda = normalizeUiTree({ nodes: [{ id: '1', name: 'a', parentId: '', value: { type: 'element', data: { type: 'text', data: {} } } }] })
  const payload = normalizeUiTree({ nodes: [{ id: '1', name: 'a', parentId: '', value: { type: 'element', data: { text: { content: 'hi' } } } }] })
  assert.equal(rda[0].kind, 'text')
  assert.equal(payload[0].kind, 'text', 'ui_node_add 的 data 形态（{text:{…}}）也必须识别出类型')
  assert.equal(normalizeUiTree(null), null)
})

// ---------------------------------------------------------------- R2 悬空控件

test('R2 正例：脚本引用的控件名全部存在 → 不报悬空', () => {
  const ok = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); const s = ui.findChildByName('score'); b.events.on('pointerdown', () => {});")],
  })
  assert.deepEqual(only(ok, 'UI_TREE_REF_UNRESOLVED'), [])
  assert.equal(ok.checked.refs, 2)
})

test('R2 反例：引用不存在控件（悬空绑定）→ error，hint 给出两条出路', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('ghostButton'); b.events.on('pointerdown', () => {});")],
  })
  const hits = only(bad, 'UI_TREE_REF_UNRESOLVED')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].subject, 'ghostButton')
  assert.equal(hits[0].retryable, true)
  assert.match(hits[0].hint, /ui_node_add/)
  assert.match(hits[0].hint, /ui_tree_read/)
  assert.equal(bad.ok, false, '悬空控件必须让门变红')
})

test('R2 反例：子树寻址越界（panel.findChildByName 取到兄弟节点）也变红', () => {
  const tree = {
    nodes: [
      { id: 'ROOT_ID', name: 'Root', parentId: '', childrenIds: ['SCREEN'], value: undefined },
      node('SCREEN', 'screen', 'ROOT_ID', null),
      node('10', 'panel', 'SCREEN', 'box'),
      node('11', 'inside', '10', 'text'),
      node('12', 'elsewhere', 'SCREEN', 'text'),
    ],
  }
  const good = validateUiBindings({ uiTree: tree, scripts: [client('c.js', "const p = ui.findChildByName('panel'); p.findChildByName('inside').events.on('pointerup', () => {});")] })
  assert.deepEqual(only(good, 'UI_TREE_REF_UNRESOLVED'), [], '合法子树引用不该报')
  const bad = validateUiBindings({ uiTree: tree, scripts: [client('c.js', "const p = ui.findChildByName('panel'); p.findChildByName('elsewhere').events.on('pointerup', () => {});")] })
  assert.equal(only(bad, 'UI_TREE_REF_UNRESOLVED').length, 1, 'elsewhere 不在 panel 子树里')
})

test('R2 反例：绑定提案的 nodeId 不在树里 → 悬空（写入前的门）', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [],
    bindings: [
      { nodeId: '999999', event: 'pointerdown', script: { side: 'client', entry: 'index.js' } },
      { name: 'bagButton', event: 'pointerup', script: { side: 'client', entry: 'index.js' } },
      { event: 'load' },
    ],
  })
  const hits = only(bad, 'UI_TREE_REF_UNRESOLVED')
  assert.equal(hits.length, 2, '一个指向不存在的 id，一个既无 nodeId 也无 name')
  assert.deepEqual(bad.checked.bindings, 3)
})

test('R2 正例：MCP 的 {box:{…}} add-payload 形态建出的节点能被正常识别', () => {
  const tree = { nodes: [{ id: '7', name: 'newBtn', parentId: 'SCREEN', childrenIds: [], value: { type: 'element', data: { box: { visible: true } } } }] }
  const ok = validateUiBindings({ uiTree: tree, scripts: [client('index.js', "ui.findChildByName('newBtn').events.on('pointerdown', () => {});")] })
  assert.deepEqual(only(ok, 'UI_TREE_REF_UNRESOLVED'), [])
})

test('R2 反例：注释里的 findChildByName 不算引用（stripComments 生效）', () => {
  assert.equal(stripComments("a.findChildByName('x'); // ui.findChildByName('commentGhost')").includes('commentGhost'), false)
  assert.equal(stripComments("/* ui.findChildByName('blockGhost') */ a.events.on('pointerdown', () => {});").includes('blockGhost'), false)
  const result = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "/* const g = ui.findChildByName('blockGhost'); */\nui.findChildByName('bagButton').events.on('pointerdown', () => {});")],
  })
  assert.deepEqual(only(result, 'UI_TREE_REF_UNRESOLVED'), [], '注释不该变红')
})

// ---------------------------------------------------------------- R3 事件名

test('R3 正例：五个合法事件名全部放过（含 add/once 别名 API）', () => {
  const content = [
    "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {});",
    "b.events.once('pointerup', () => {});",
    "const i = ui.findChildByName('inputBox'); i.events.add('focus', () => {});",
    "i.events.on('blur', () => {});",
    "const a = ui.findChildByName('avatar'); a.events.on('load', () => {});",
  ].join('\n')
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', content)] })
  assert.deepEqual(only(ok, 'UI_EVENT_NAME_INVALID'), [])
  assert.equal(ok.checked.registrations, 5)
})

test('R3 反例：click 不是 UiEvent → 变红，hint 列出五个名', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.events.on('click', () => {});")],
  })
  const hits = only(bad, 'UI_EVENT_NAME_INVALID')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].event, 'click')
  assert.deepEqual(hits[0].allowedEvents, [...UI_EVENT_NAMES])
  assert.deepEqual([...UI_EVENT_NAMES].sort(), ['blur', 'load', 'pointerdown', 'pointerup', 'focus'].sort())
  assert.equal(bad.ok, false)
})

test('R3 反例：双引号写的事件名同样要拦（真实脚本混用两种引号）', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', 'const b = ui.findChildByName("bagButton"); b.events.on("tap", () => {});')],
  })
  assert.equal(only(bad, 'UI_EVENT_NAME_INVALID').length, 1)
})

test('R3 关键防误报：非 UI 发射器的 .events.on 不许当 UI 绑定报错（真实地图 remoteChannel 用 client 事件）', () => {
  const scan = scanScriptBindings(REAL_CLIENT_SCRIPT)
  const foreign = scan.registrations.filter((reg) => reg.event === 'client')
  assert.equal(foreign.length, 1, '真实脚本里确实有一处 remoteChannel.events.on("client")')
  assert.equal(foreign[0].isUi, false, '扫描器必须认出它不是 UI 节点')
  const result = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', REAL_CLIENT_SCRIPT)] })
  assert.equal(only(result, 'UI_EVENT_NAME_INVALID').length, 0, '"client" 不是 UiEvent，但它根本不是 UI 绑定')
  const mine = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton');\nremoteChannel.events.on('client', (e) => e);\nb.events.on('pointerdown', () => {});")],
  })
  assert.deepEqual(only(mine, 'UI_EVENT_NAME_INVALID'), [])
})

test('R3/R4：clone() 出来的节点仍是 UI 节点，事件名照旧校验', () => {
  const content = "const b = ui.findChildByName('bagButton'); const c = b.clone(); c.events.on('pointerdown', () => {}); c.events.on('swipe', () => {});"
  const bad = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', content)] })
  assert.equal(only(bad, 'UI_EVENT_NAME_INVALID').length, 1, 'clone 上的 swipe 要变红')
})

// ---------------------------------------------------------------- R4 类型匹配

test('R4 正例：focus/blur 挂在 input、load 挂在 image → 不报类型问题', () => {
  const ok = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const i = ui.findChildByName('inputBox'); i.events.on('focus', () => {});\nconst a = ui.findChildByName('avatar'); a.events.on('load', () => {});")],
  })
  assert.deepEqual(only(ok, 'UI_EVENT_KIND_MISMATCH'), [])
})

test('R4 反例：focus 挂在 text 节点 → 只出 warning，不炸门', () => {
  const warn = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const s = ui.findChildByName('score'); s.events.on('focus', () => {});")],
  })
  const hits = only(warn, 'UI_EVENT_KIND_MISMATCH')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].severity, 'warning')
  assert.equal(hits[0].requiredKind, 'input')
  assert.equal(warn.errorCount, 0)
  assert.equal(warn.ok, true, '类型不匹配是建议级：合法事件名不该被当成写坏')
})

test('R4 反例：load 挂在 image 之外的控件 + 绑定提案同样受检', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.events.on('load', () => {});")],
    bindings: [{ name: 'score', event: 'load', script: { side: 'client', entry: 'index.js' } }],
  })
  assert.equal(only(bad, 'UI_EVENT_KIND_MISMATCH').length, 2, '脚本与绑定提案各一条')
})

// ---------------------------------------------------------------- R5 脚本存在性

test('R5 正例：import 命中脚本清单 → 不报（真实地图的 ./cilentConfig.js 就是这么过的）', () => {
  const ok = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', 'import { ColorList } from "./cilentConfig.js";\nconst b = ui.findChildByName("bagButton"); b.events.on("pointerdown", () => {});'), client('cilentConfig.js', 'export { ColorList };')],
  })
  assert.deepEqual(only(ok, 'UI_SCRIPT_NOT_FOUND'), [])
  assert.equal(ok.checked.imports, 1)
})

test('R5 反例：import 指向不存在的脚本 → error，hint 指到 script_list_runtime', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', 'import { X } from "./nope.js";\nconst b = ui.findChildByName("bagButton"); b.events.on("pointerdown", () => {});')],
  })
  const hits = only(bad, 'UI_SCRIPT_NOT_FOUND')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].subject, './nope.js')
  assert.match(hits[0].hint, /script_list_runtime/)
  assert.equal(bad.ok, false)
})

test('R5 反例：绑定声明的 side+entry 不在清单里（含 server 侧）', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "ui.findChildByName('bagButton').events.on('pointerdown', () => {});")],
    bindings: [
      { name: 'bagButton', event: 'pointerup', script: { side: 'server', entry: 'index.js' } },
      { name: 'bagButton', event: 'blur', script: { side: 'client', entry: 'ghost.js' } },
    ],
  })
  assert.equal(only(bad, 'UI_SCRIPT_NOT_FOUND').length, 2)
})

test('R5 降级：scriptsAreComplete:false 时未命中的 import 只算 warning（不许把调用方偷懒说成图坏了）', () => {
  const partial = validateUiBindings({
    uiTree: sampleTree(),
    scriptsAreComplete: false,
    scripts: [client('index.js', 'import { X } from "./helper.js";\nconst b = ui.findChildByName("bagButton"); b.events.on("pointerdown", () => {});')],
  })
  const hits = only(partial, 'UI_SCRIPT_NOT_FOUND')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].severity, 'warning')
  assert.equal(partial.ok, true, '清单不全不该判死')
})

// ---------------------------------------------------------------- R6 重复绑定

test('R6 正例：同控件不同事件、不同控件同事件都不算重复', () => {
  const ok = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {}); b.events.on('pointerup', () => {});\nconst a = ui.findChildByName('avatar'); a.events.on('pointerdown', () => {});")],
  })
  assert.deepEqual(only(ok, 'UI_BINDING_DUPLICATE'), [])
})

test('R6 反例：同一脚本对同一控件同一事件注册两次 → 回调会跑两遍，变红', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {}); b.events.add('pointerdown', () => {});")],
  })
  const hits = only(bad, 'UI_BINDING_DUPLICATE')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].event, 'pointerdown')
  assert.deepEqual(hits[0].lines.length, 2)
  assert.equal(bad.ok, false)
})

test('R6 反例：绑定提案里重复声明同一 (控件,事件) 也拦', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [],
    bindings: [
      { name: 'bagButton', event: 'pointerdown', script: { side: 'client', entry: 'index.js' } },
      { name: 'bagButton', event: 'pointerdown', script: { side: 'client', entry: 'index.js' } },
    ],
  })
  assert.equal(only(bad, 'UI_BINDING_DUPLICATE').length, 1)
})

test('R6 边界：remove/off 是解绑，不计入重复注册', () => {
  const ok = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {}); b.events.off('pointerdown', () => {}); b.events.remove('pointerdown', () => {});")],
  })
  assert.deepEqual(only(ok, 'UI_BINDING_DUPLICATE'), [])
})

// ---------------------------------------------------------------- R7 PointerEventBehavior

test('R7 正例：四个成员名和 0..3 的整数都放过', () => {
  assert.deepEqual(Object.keys(POINTER_EVENT_BEHAVIOR_MEMBERS), ['DISABLE_AND_BLOCK_PASS_THROUGH', 'DISABLE', 'BLOCK_PASS_THROUGH', 'ENABLE'])
  assert.deepEqual([...POINTER_EVENT_BEHAVIOR_VALUES], [0, 1, 2, 3])
  const content = [
    "const b = ui.findChildByName('bagButton');",
    "b.pointerEventBehavior = PointerEventBehavior.BLOCK_PASS_THROUGH;",
    "b.events.on('pointerdown', () => {});",
    "const a = ui.findChildByName('avatar'); a.pointerEventBehavior = PointerEventBehavior.ENABLE;",
    "const s = ui.findChildByName('score'); s.pointerEventBehavior = PointerEventBehavior.DISABLE;",
    "const i = ui.findChildByName('inputBox'); i.pointerEventBehavior = 2;",
  ].join('\n')
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', content)] })
  assert.deepEqual(only(ok, 'UI_POINTER_EVENT_BEHAVIOR_INVALID'), [])
  assert.equal(ok.checked.behaviors, 4)
})

test('R7 反例：不存在的枚举成员 → 变红并列出四个合法成员', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.pointerEventBehavior = PointerEventBehavior.HOVER;")],
  })
  const hits = only(bad, 'UI_POINTER_EVENT_BEHAVIOR_INVALID')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].value, 'HOVER')
  assert.deepEqual(hits[0].allowedMembers, ['DISABLE_AND_BLOCK_PASS_THROUGH', 'DISABLE', 'BLOCK_PASS_THROUGH', 'ENABLE'])
  assert.equal(bad.ok, false)
})

test('R7 反例：越界数字（4 / -1）→ 变红', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [client('index.js', "const b = ui.findChildByName('bagButton'); b.pointerEventBehavior = 4;\nconst a = ui.findChildByName('avatar'); a.pointerEventBehavior = -1;")],
  })
  const hits = only(bad, 'UI_POINTER_EVENT_BEHAVIOR_INVALID')
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map((hit) => hit.value), [4, -1])
})

// ---------------------------------------------------------------- R8 重名

test('R8 正例：名字唯一 → 不报歧义（真实 61 节点树就是这么过的）', () => {
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [] })
  assert.deepEqual(only(ok, 'UI_NODE_NAME_AMBIGUOUS'), [])
  const real = validateUiBindings({ uiTree: REAL_UI_TREE, scripts: [] })
  assert.deepEqual(only(real, 'UI_NODE_NAME_AMBIGUOUS'), [], '旧图里没有任何重名控件')
})

test('R8 反例：两个控件同名 → 按名寻址无法确定命中谁，变红', () => {
  const tree = {
    nodes: [
      { id: 'ROOT_ID', name: 'Root', parentId: '', childrenIds: ['SCREEN'], value: undefined },
      node('SCREEN', 'screen', 'ROOT_ID', null),
      node('20', 'dup', 'SCREEN', 'box'),
      node('21', 'dup', 'SCREEN', 'text'),
    ],
  }
  const bad = validateUiBindings({ uiTree: tree, scripts: [client('index.js', "ui.findChildByName('dup').events.on('pointerdown', () => {});")] })
  const hits = only(bad, 'UI_NODE_NAME_AMBIGUOUS')
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].ids, ['20', '21'])
  assert.match(hits[0].hint, /ui_node_add/)
  assert.equal(bad.ok, false)
})

// ---------------------------------------------------------------- R9 孤儿节点

test('R9 正例：父链完整 → 不报（含根节点 parentId 为空）', () => {
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [] })
  assert.deepEqual(only(ok, 'UI_ORPHAN_NODE'), [])
  const real = validateUiBindings({ uiTree: REAL_UI_TREE, scripts: [] })
  assert.deepEqual(only(real, 'UI_ORPHAN_NODE'), [], '旧图父链完整')
})

test('R9 反例：parentId 指向不存在的节点 → 变红（引擎删父节点不重挂子节点）', () => {
  const tree = { nodes: [node('50', 'kid', 'NO_SUCH_PARENT', 'text')] }
  const bad = validateUiBindings({ uiTree: tree, scripts: [] })
  const hits = only(bad, 'UI_ORPHAN_NODE')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].nodeId, '50')
  assert.equal(hits[0].parentId, 'NO_SUCH_PARENT')
  assert.match(hits[0].hint, /ui_node_remove/)
  assert.equal(bad.ok, false)
})

// ---------------------------------------------------------------- R10 侧别

test('R10 正例：client 脚本里的 UI 绑定不报侧别问题', () => {
  const content = "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {});"
  const ok = validateUiBindings({ uiTree: sampleTree(), scripts: [client('index.js', content)] })
  assert.deepEqual(only(ok, 'UI_BINDING_SIDE_INVALID'), [])
})

test('R10 反例：server 脚本里写 UI 绑定 → 变红（ui/findChildByName 只在 client 侧存在）', () => {
  const bad = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [{ side: 'server', entry: 'index.js', content: "const b = ui.findChildByName('bagButton'); b.events.on('pointerdown', () => {});" }],
  })
  const hits = only(bad, 'UI_BINDING_SIDE_INVALID')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].side, 'server')
  assert.match(hits[0].hint, /side:client/)
  assert.equal(bad.ok, false)
})

test('R10 边界：server 脚本不产生 UI 侧的悬空/事件名误报（它压根没有 UI 面）', () => {
  const result = validateUiBindings({
    uiTree: sampleTree(),
    scripts: [{ side: 'server', entry: 'index.js', content: "const b = entity.findChildByName('ghost'); b.events.on('click', () => {});" }],
  })
  assert.deepEqual(only(result, 'UI_TREE_REF_UNRESOLVED'), [], 'server 侧的引用交给 R10 说，不重复报悬空')
  assert.deepEqual(only(result, 'UI_EVENT_NAME_INVALID'), [])
  assert.equal(only(result, 'UI_BINDING_SIDE_INVALID').length, 1)
})

// ---------------------------------------------------------------- 只读性（红线）

/** Deep freeze so ANY write attempt throws (ESM is strict mode) instead of silently passing. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

test('红线：校验器只读 —— 深冻结真实 uiTree 后跑校验不得抛错', () => {
  const frozen = deepFreeze(JSON.parse(JSON.stringify(REAL_UI_TREE)))
  assert.doesNotThrow(() => validateUiBindings({ uiTree: frozen, scripts: [client('index.js', REAL_CLIENT_SCRIPT)] }))
  const frozenTree = deepFreeze(JSON.parse(JSON.stringify(sampleTree())))
  assert.doesNotThrow(() => validateUiBindings({ uiTree: frozenTree, scripts: [], bindings: [{ name: 'bagButton', event: 'pointerdown' }] }))
})

test('红线：旧地图 uiTree 逐字节不变 —— 输入深拷贝前后 JSON 字节完全相等', () => {
  const before = JSON.stringify(REAL_UI_TREE)
  const clone = JSON.parse(before)
  const script = { side: 'client', entry: 'index.js', content: REAL_CLIENT_SCRIPT }
  const result = validateUiBindings({ uiTree: REAL_UI_TREE, scripts: [script] })
  const after = JSON.stringify(REAL_UI_TREE)
  assert.equal(before.length, 40003, '真实 uiTree 重序列化后是 40003 个字符')
  assert.equal(Buffer.byteLength(REAL_UI_TREE_RAW, 'utf8'), 40073, '盘上 blob 是 40073 字节（中文属性值按 UTF-8 计 3 字节）')
  assert.equal(after, before, '跑完校验后原对象必须逐字节不变')
  assert.equal(JSON.stringify(clone), before, '深拷贝与原件等价')
  assert.equal(sha256(before), sha256(after))
  assert.equal(sha256(JSON.stringify(REAL_UI_TREE)), sha256(JSON.stringify(clone)), '输入没有被悄悄规范化（键序、数字形态都不许变）')
  assert.equal(script.content, REAL_CLIENT_SCRIPT, '脚本正文也不许改')
  assert.ok(result.checked.nodes > 0)
})

test('已知陷阱（不是校验器造成的）：JSON.parse 会把数字形态的节点 id 提前，parse→stringify 不逐字节等于原文', () => {
  // 这条存在是为了把"逐字节不变"的口径钉死：只有原文本身能被断言成逐字节不变，
  // 任何经过 JSON.parse 的往返都会重排 3079413 这类"像数组下标的键"。
  const reserialized = JSON.stringify(JSON.parse(REAL_UI_TREE_RAW))
  assert.notEqual(reserialized, REAL_UI_TREE_RAW, 'parse→stringify 必然改键序，这是 JS 对象语义')
  assert.equal(reserialized.length, REAL_UI_TREE_RAW.length, '只是顺序变了，字节数没变')
  assert.equal(REAL_UI_TREE_RAW.startsWith('{"100207687_132055051"'), true, '盘上第一个键是非数字形态的 id')
  assert.equal(reserialized.startsWith('{"3079413"'), true, '重排后纯数字 id 被提到最前')
  // 校验器不做任何序列化：它读的是调用方给的那个对象。
  const before = JSON.stringify(REAL_UI_TREE)
  validateUiBindings({ uiTree: REAL_UI_TREE, scripts: [] })
  assert.equal(JSON.stringify(REAL_UI_TREE), before)
})

test('红线：反例同样不改写输入（坏数据跑完仍是原字节）', () => {
  const tree = { nodes: [{ id: '50', name: 'kid', parentId: 'NO_SUCH_PARENT', childrenIds: [], value: { type: 'element', data: { type: 'text', data: {} } } }] }
  const before = JSON.stringify(tree)
  const scripts = [client('index.js', "const g = ui.findChildByName('ghost'); g.events.on('click', () => {}); g.pointerEventBehavior = 9;")]
  const scriptsBefore = JSON.stringify(scripts)
  const result = validateUiBindings({ uiTree: tree, scripts })
  assert.ok(result.errorCount >= 4, '这份反例应该至少红四条')
  assert.equal(JSON.stringify(tree), before, '坏输入也不许被顺手改写')
  assert.equal(JSON.stringify(scripts), scriptsBefore, 'scripts 数组元素同样只读')
})

test('红线：输出确定性 —— 同一输入两次跑出完全相同的问题集', () => {
  const input = () => ({ uiTree: JSON.parse(JSON.stringify(REAL_UI_TREE)), scripts: [client('index.js', REAL_CLIENT_SCRIPT)] })
  assert.deepEqual(validateUiBindings(input()), validateUiBindings(input()))
})

test('行号准确性：问题里的 line 必须指向作者在看的那一行（注释折叠不许漂移）', () => {
  const lines = REAL_CLIENT_SCRIPT.split('\n')
  const scan = scanScriptBindings(REAL_CLIENT_SCRIPT)
  for (const reg of scan.registrations.filter((item) => item.isUi)) {
    assert.match(lines[reg.line - 1], /\.events\s*\.\s*(on|once|add)\s*\(/, `第 ${reg.line} 行不是事件注册行：${lines[reg.line - 1]}`)
  }
  for (const ref of scan.refs) {
    assert.match(lines[ref.line - 1], /findChildByName\s*\(/, `第 ${ref.line} 行不是控件引用行：${lines[ref.line - 1]}`)
  }
  for (const behavior of scan.behaviors) {
    assert.match(lines[behavior.line - 1], /pointerEventBehavior|PointerEventBehavior/, `第 ${behavior.line} 行不是行为赋值行`)
  }
  // 悬空反例的 path 也必须带这个行号。
  const bad = validateUiBindings({ uiTree: { nodes: [] }, scripts: [client('index.js', REAL_CLIENT_SCRIPT)] })
  assert.match(only(bad, 'UI_TREE_REF_UNRESOLVED')[0].path, /@83|@\d+$/)
  assert.ok(bad.ok === false)
})

// ---------------------------------------------------------------- 真实地图回归

test('真实地图（61 节点 uiTree + 真实客户端脚本）整体验证通过，0 error 0 warning', () => {
  const scripts = [client('index.js', REAL_CLIENT_SCRIPT), client('cilentConfig.js', 'export { ColorList };')]
  const result = validateUiBindings({ uiTree: REAL_UI_TREE, scripts })
  assert.deepEqual(result.problems, [], `旧图不该被判坏：${result.problems.map((item) => `${item.code}@${item.path}`).join(', ')}`)
  assert.equal(result.errorCount, 0)
  assert.equal(result.warningCount, 0)
  assert.equal(result.ok, true)
  assert.deepEqual(result.checked, { nodes: 61, scripts: 2, bindings: 0, refs: 13, registrations: 2, behaviors: 1, imports: 1 })
})

test('真实地图里确实存在被校验覆盖的绑定（不是靠空输入蒙过的绿灯）', () => {
  const scan = scanScriptBindings(REAL_CLIENT_SCRIPT)
  assert.equal(scan.refs.length, 13)
  assert.deepEqual(
    scan.refs.map((ref) => ref.name).slice(0, 4),
    ['bagButton', 'cameraButton', 'sidebar', 'choosecase'],
  )
  const uiRegs = scan.registrations.filter((reg) => reg.isUi)
  assert.deepEqual(uiRegs.map((reg) => reg.event).sort(), ['blur', 'pointerdown'])
  assert.equal(scan.behaviors.length, 1)
  assert.equal(scan.behaviors[0].value, 'BLOCK_PASS_THROUGH')
})

test('真实地图反例：删掉一个控件后引用它 → 门立刻变红（证明规则作用在真数据上）', () => {
  const scripts = [client('index.js', REAL_CLIENT_SCRIPT), client('cilentConfig.js', 'export { ColorList };')]
  const good = validateUiBindings({ uiTree: REAL_UI_TREE, scripts })
  assert.equal(good.ok, true)
  const withoutButton = { nodes: normalizeUiTree(REAL_UI_TREE).filter((item) => item.name !== 'bagButton') }
  const mutated = validateUiBindings({ uiTree: withoutButton, scripts })
  assert.equal(mutated.ok, false, '真实引用被抽掉后必须变红')
  assert.equal(only(mutated, 'UI_TREE_REF_UNRESOLVED').length, 1)
  assert.equal(only(mutated, 'UI_TREE_REF_UNRESOLVED')[0].subject, 'bagButton')
})

test('内嵌真实 fixture 与盘上 blob 逐字节一致（盘不在时显式 skip，绝不静默通过）', (t) => {
  const uiPath = path.join(REAL_MAP_ROOT, 'source/blobs', REAL_UI_TREE_BLOB_NAME)
  const scriptPath = path.join(REAL_MAP_ROOT, 'source/blobs', REAL_CLIENT_SCRIPT_BLOB_NAME)
  if (!existsSync(uiPath) || !existsSync(scriptPath)) {
    t.skip(`盘上真实地图不可用（${REAL_MAP_ROOT}），已改用内嵌字节回归；可用 BOX3_REAL_MAP_PROJECT 指定路径`)
    return
  }
  assert.equal(readFileSync(uiPath, 'utf8'), REAL_UI_TREE_RAW, '内嵌 uiTree 必须就是盘上那份字节')
  assert.equal(readFileSync(scriptPath, 'utf8'), REAL_CLIENT_SCRIPT, '内嵌客户端脚本必须就是盘上那份字节')
  assert.equal(sha256(REAL_UI_TREE_RAW), 'ec10a3bc74712b3536788e19b7be1d5eb545112ecc71e59785ce3b1c43892530')
})

// ---------------------------------------------------------------- 规则表自证

test('规则表：十条规则，每条都有对应反例真的变红', () => {
  assert.equal(BINDING_RULES.length, 10)
  const negatives = validateUiBindings({
    uiTree: { nodes: [{ id: '1', name: 'dup', parentId: 'GONE', value: { type: 'element', data: { type: 'text', data: {} } } }, { id: '2', name: 'dup', parentId: '', value: { type: 'screen', data: {} } }] },
    scripts: [
      client('index.js', [
        'import { X } from "./ghost.js";',
        "const g = ui.findChildByName('ghostButton');",
        "g.events.on('click', () => {});",
        "g.events.on('pointerdown', () => {}); g.events.on('pointerdown', () => {});",
        "const d = ui.findChildByName('dup'); d.events.on('load', () => {});",
        'g.pointerEventBehavior = PointerEventBehavior.HOVER;',
      ].join('\n')),
      { side: 'server', entry: 'index.js', content: "const b = ui.findChildByName('dup'); b.events.on('focus', () => {});" },
    ],
    bindings: [{ nodeId: 'nope', event: 'nope', script: { side: 'client', entry: 'ghost.js' } }],
  })
  const hit = codesOf(negatives)
  for (const rule of BINDING_RULES) {
    if (rule.code === 'UI_BINDING_INPUT_INVALID') continue // R1 的反例是形状错的输入，本身无法再带数据
    assert.ok(hit.has(rule.code), `${rule.id}/${rule.code} 没有反例变红`)
  }
  assert.ok(hit.has('UI_EVENT_KIND_MISMATCH'), 'R4 也要在混合反例里出现')
  assert.equal(negatives.ok, false)
})

test('校验器不 import 任何东西：src/ui-binding.js 是零依赖纯函数（泳道边界）', () => {
  const source = readFileSync(new URL('../src/ui-binding.js', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import\s.*$/gm)]
  assert.deepEqual(imports.map((item) => item[0]), [], '本泳道不得依赖 errors.js / _shared.js 等既有文件')
  assert.doesNotMatch(source, /require\(/)
})
