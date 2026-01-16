import React from "react";
import { linkifyText } from "./linkifyText";

type ChatMessageProps = {
  role: "user" | "assistant" | string;
  content: string;
};

export default function ChatMessage({ role, content }: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div className={`w-full flex ${isUser ? "justify-end" : "justify-start"} my-2`}>
      <div
        className={[
          "max-w-[90%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap",
          isUser ? "bg-gray-900 text-white" : "bg-white text-gray-900 border",
        ].join(" ")}
      >
        {linkifyText(content)}
      </div>
    </div>
  );
}
