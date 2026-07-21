import { ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "@rstest/core";
import { render, screen } from "@testing-library/react";

import { ProtocolLabel } from "@/components/protocol-label";

test("shows the protocol icon only when enabled", () => {
  const { container, rerender } = render(<ProtocolLabel protocol={ProviderProtocol.OpenAIResponse} />);

  expect(screen.getByText("OpenAI Response")).toBeInTheDocument();
  expect(container.querySelector("img")).toBeNull();

  rerender(<ProtocolLabel protocol={ProviderProtocol.OpenAIResponse} showIcon />);
  expect(container.querySelector("img")).toHaveAttribute("alt", "");
});
