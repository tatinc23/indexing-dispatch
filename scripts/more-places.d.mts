export interface MorePlacesSite {
  name: string;
  submitUrl: string;
  tag: string;
  note?: string;
  verifiedOn: string;
}
export interface MorePlacesGroup {
  title: string;
  sites: MorePlacesSite[];
}
export interface MorePlacesData {
  checked: string;
  groups: MorePlacesGroup[];
}
export function renderMorePlacesPage(data: MorePlacesData, siteUrl: string): string;
