declare module '*.module.css' {
  const content: any;
  export default content;
}

declare module '*.glsl' {
  const content: any;
  export default content;
}

declare module '*.frag' {
  const content: any;
  export default content;
}

declare module '*.vert' {
  const content: any;
  export default content;
}

declare module '*.mp4' {
  const content: any;
  export default content;
}

declare module '@box/ao-mesher';

interface Navigator {
  /**
   * Only available in secure context (https)
   * see: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/userAgentData
   */
  userAgentData?: {
    platform: string;
  };
}
