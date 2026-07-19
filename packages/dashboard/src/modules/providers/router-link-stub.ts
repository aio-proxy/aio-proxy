import type React from "react";

import { createElement } from "react";

export const RouterLinkStub: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = (props) =>
  createElement("a", props);
