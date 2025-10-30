// 最小可运行的 LangGraph 示例（可使用 `langgraph dev` 启动）
// 说明：此示例定义一个简单的 Echo 图，接收输入并回显输出。
// 使用方法：
// 1) 在该目录执行 `npm install`
// 2) 运行 `npm run dev`
// 3) 打开开发服务器提供的 UI 或 API 进行调用

import { Annotation, StateGraph, END } from "@langchain/langgraph";

// 定义状态结构（最小化，仅包含 input 与 output）
// 使用 Annotation 提供类型与可视化提示
const State = Annotation.Root({
  input: Annotation.string({ description: "用户输入" }),
  output: Annotation.string({ description: "模型输出" }),
});

// 简单的节点：将 input 回显为 output
async function echoNode(state: { input: string; output?: string }) {
  const text = state.input ?? "";
  // 返回新的状态片段（LangGraph 将进行状态合并）
  return { output: `Echo: ${text}` };
}

// 构建并编译图：单节点后直接结束
const workflow = new StateGraph(State)
  .addNode("echo", echoNode)
  .addEdge("echo", END);

export const graph = workflow.compile();

// 一些可选的元信息导出，便于开发 UI 展示
export const app = graph;
export const name = "examples-echo";
export const description = "最小 Echo 图，适合验证 langgraph dev 与流式管线";

// 可选：如果需要在 dev 模式下进行快速自测，可以添加如下函数
// （dev 服务会接管入口，此处仅保留示例）
async function demo() {
  const result = await graph.invoke({ input: "hello" });
  console.log("invoke result:", result);
}
// demo();