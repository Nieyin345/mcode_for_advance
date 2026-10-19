/** ARC-003: 真 Claude/Pi 共用 AskUserQuestion helper 回归，纯内存、无外部调用。 */
import { parseQuestions, formatAnswersForModel } from "../../src/main/lib/askQuestion.js";
let total = 0, failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : " " + String(detail)}`);
};
const standard = parseQuestions({
  questions: [{ header: "模式", question: "使用哪个引擎?", multiSelect: false,
    options: [{ label: "Claude", description: "A" }, { label: "Pi" }] }],
});
check("普通问题数组正确保留选项", standard.length === 1 && standard[0].options.length === 2);
const wrapped = parseQuestions({questions:{item:[
  {question:"选哪种?",options:{item:[{label:"A"},{label:"B"}]}}
]}});
check("XML wrapper 的合法 item 数组仍可解析", wrapped.length === 1 && wrapped[0].options.length === 2);

let malformedThrew = false, malformed: ReturnType<typeof parseQuestions> = [];
try {
  malformed = parseQuestions({questions:[{question:"Malformed options",options:{item:{label:"unexpected singleton"}}}]});
} catch {malformedThrew=true;}
check("不合法 options.item 不能让 native AskUserQuestion 抛出运行时异常", !malformedThrew);
check("坏 options.item 不得被采纳为实际选项", malformed.length === 1 && malformed[0].options.length === 0);

const mixed= parseQuestions({questions:{item:[
  {question:"valid",options:{item:[{label:"go"}]}},
  {question:"bad",options:{item:"not array"}},
]}});
check("单个坏问题选项不能吞掉前后正常问题",mixed.length===2 && mixed[0].options.length===1 && mixed[1].options.length===0);

const answered = formatAnswersForModel({"What?":"yes","Multi":["A","B"]},
 [{question:"What?",header:"a",multiSelect:false,options:[]},{question:"Multi",header:"b",multiSelect:true,options:[]}]);
check("真实字符串/多选仍有正常结果",answered==="What?: yes\nMulti: A, B",answered);
const pollution= formatAnswersForModel({},
 [{question:"constructor",header:"a",multiSelect:false,options:[]},
  {question:"toString",header:"b",multiSelect:false,options:[]},
  {question:"__proto__",header:"c",multiSelect:false,options:[]}]);
check("未回答的继承属性不能被伪造成用户回答",
  pollution==="constructor: (no answer)\ntoString: (no answer)\n__proto__: (no answer)",pollution);
const own = Object.create(null) as Record<string,string>;
own["toString"]="I choose custom";
check("真正 own key 即使名为 toString 仍应算用户回答",
  formatAnswersForModel(own,[{question:"toString",header:"b",multiSelect:false,options:[]}])==="toString: I choose custom");

console.log(`ask-question-guard-smoke: ${total-failures}/${total} PASS`);
if (failures) process.exitCode=1;
