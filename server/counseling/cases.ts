import type { CounselingCase } from "../../shared/counseling.js";

export const counselingCases: CounselingCase[] = [
  {
    id: "academic", name: "林晓", year: "大二 · 工科", title: "成绩背后的压力",
    background: "连续两门课程未通过，近期常缺席小组活动。主动预约了这次谈话。",
    opening: "老师，我最近总是学不进去。大家都在往前走，好像只有我在原地。",
    concern: "我最怕的不是补考，是爸妈觉得我让他们失望了。晚上脑子停不下来，第二天上课又很困。",
    goal: "理解压力来源，商定一项可执行的支持行动。",
    defaults: { emotion: "焦虑", intensity: 4, trust: 45, openness: 40, risk: "ordinary" }
  },
  {
    id: "dormitory", name: "陈予", year: "大一 · 文科", title: "不想回去的宿舍",
    background: "宿舍作息冲突后，学生提出换宿舍申请，尚未与室友当面沟通。",
    opening: "老师，我真的不想回宿舍了。每次说话，他们都像是在针对我。",
    concern: "他们夜里打游戏，我提过一次，他们说我事多。后来我一进门就没人说话了。",
    goal: "区分事实与感受，尊重学生意愿讨论冲突处理。",
    defaults: { emotion: "委屈", intensity: 4, trust: 40, openness: 45, risk: "ordinary" }
  },
  {
    id: "relationship", name: "周宁", year: "大三 · 艺术", title: "关系结束以后",
    background: "近期结束一段亲密关系，朋友发现其社交明显减少，陪同预约谈话。",
    opening: "其实也没什么好说的，分开就分开了。我就是不太想见人。",
    concern: "以前什么事都一起做，现在连吃饭都不知道找谁。我不想一直麻烦朋友。",
    goal: "允许沉默和情绪表达，寻找现实支持资源。",
    defaults: { emotion: "低落", intensity: 3, trust: 35, openness: 25, risk: "screening" }
  },
  {
    id: "financial", name: "许安", year: "大二 · 经管", title: "不愿开口的困难",
    background: "近期增加兼职并迟交作业。辅导员邀请学生谈谈学习与生活安排。",
    opening: "老师，作业我会补的。能不能先别联系我家里？他们已经很累了。",
    concern: "家里收入少了，我想自己解决生活费。可兼职到很晚，课上真的撑不住。",
    goal: "尊重隐私与自主性，协商资助和学业支持。",
    defaults: { emotion: "焦虑", intensity: 3, trust: 40, openness: 30, risk: "ordinary" }
  },
  {
    id: "conflict", name: "陆川", year: "大三 · 理科", title: "处分之后的对抗",
    background: "因课堂冲突被约谈，学生认为自己被不公平对待，进入谈话时较为防御。",
    opening: "您也是来批评我的吧？反正解释了也没人听。",
    concern: "当时他先当着全班说我不认真，我才顶了一句。最后只有我被记了名字。",
    goal: "先建立可对话关系，再讨论责任和修复行动。",
    defaults: { emotion: "愤怒", intensity: 5, trust: 20, openness: 25, risk: "ordinary" }
  },
  {
    id: "safety", name: "沈言", year: "大四 · 综合", title: "持续低落的求助",
    background: "学生持续低落，近两周多次缺席，今天主动发消息说想找人谈一谈。仅供虚拟安全演练。",
    opening: "老师，我最近觉得特别累，有时会想消失就好了。不知道还能找谁说。",
    concern: "这些念头最近反复出现，我有点害怕。我现在是一个人，还没告诉身边的人。",
    goal: "直接、平静地确认即时安全，并联系专业与现实支持。",
    defaults: { emotion: "低落", intensity: 5, trust: 30, openness: 30, risk: "urgent" }
  }
];
