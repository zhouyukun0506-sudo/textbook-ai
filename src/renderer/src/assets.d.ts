// 静态资源模块声明:让 TS 认识 import xxx from './foo.png' 这类导入(Vite 处理为 URL 字符串)
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
