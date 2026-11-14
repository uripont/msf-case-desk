declare module 'pdfmake/build/pdfmake' {
  type Document = { getBuffer: () => Promise<Uint8Array> }
  const pdfMake: {
    addVirtualFileSystem: (files: Record<string, string>) => void
    addFonts: (fonts: object) => void
    setUrlAccessPolicy: (policy: (url: string) => boolean) => void
    createPdf: (definition: object) => Document
  }
  export default pdfMake
}
