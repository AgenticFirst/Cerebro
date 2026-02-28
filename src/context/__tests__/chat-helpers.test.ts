import { describe, it, expect } from "vitest";
import {
  generateId,
  titleFromContent,
  fromApiConversation,
} from "../chat-helpers";
import type { ApiConversation } from "../chat-helpers";

describe("generateId", () => {
  it("returns a 32-char hex string with no dashes", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain("-");
  });
});

describe("titleFromContent", () => {
  it("passes short strings through unchanged", () => {
    expect(titleFromContent("Hello world")).toBe("Hello world");
  });

  it("truncates strings longer than 40 chars with ellipsis", () => {
    const long = "A".repeat(60);
    const result = titleFromContent(long);
    expect(result).toBe("A".repeat(40) + "...");
    expect(result.length).toBe(43);
  });
});

describe("fromApiConversation", () => {
  it("maps snake_case API JSON to camelCase Conversation with Date objects", () => {
    const api: ApiConversation = {
      id: "abc123",
      title: "Test Chat",
      created_at: "2025-01-15T10:30:00Z",
      updated_at: "2025-01-15T11:00:00Z",
      messages: [
        {
          id: "msg1",
          conversation_id: "abc123",
          role: "user",
          content: "Hello",
          model: null,
          token_count: null,
          created_at: "2025-01-15T10:30:00Z",
        },
      ],
    };

    const conv = fromApiConversation(api);

    expect(conv.id).toBe("abc123");
    expect(conv.title).toBe("Test Chat");
    expect(conv.createdAt).toBeInstanceOf(Date);
    expect(conv.updatedAt).toBeInstanceOf(Date);
    expect(conv.createdAt.toISOString()).toBe("2025-01-15T10:30:00.000Z");
    expect(conv.messages).toHaveLength(1);
    expect(conv.messages[0].conversationId).toBe("abc123");
    expect(conv.messages[0].createdAt).toBeInstanceOf(Date);
    expect(conv.messages[0].model).toBeUndefined();
    expect(conv.messages[0].tokenCount).toBeUndefined();
  });
});
