// components/linkifyText.tsx
import React from "react";

const urlRegex = /(https?:\/\/[^\s]+)/g;

export function linkifyText(text: string): React.ReactNode[] {
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (part.match(urlRegex)) {
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500 underline break-all"
        >
          {part}
        </a>
      );
    }

    return <span key={index}>{part}</span>;
  });
}
