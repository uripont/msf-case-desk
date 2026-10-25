import { Option } from 'effect'

export type BrandLogo = {
  readonly src: string
  readonly alt: string
}

export const BRAND = {
  productName: 'Case Desk',
  organisation: 'Metges Sense Fronteres',
  maybeLogo: Option.some<BrandLogo>({
    src: '/brand/msf-logo-positive-ca.svg',
    alt: 'Metges Sense Fronteres',
  }),
}
