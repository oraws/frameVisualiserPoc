/** Mirrors public/assets/mouldings/POL-4875/profile.json so the renderer remains synchronous. */
export type ProfilePoint = readonly [uMm:number, zMm:number];
export const veronaProfile: ProfilePoint[] = [[0,15],[2,15],[3.5,21],[5,26],[7,27],[9,22],[12,19],[16,19],[20,25],[24,32],[29,38],[34,43],[40,46],[46,48],[51,48],[56,45],[61,40],[66,34],[71,29],[75,28],[79,32],[83,35],[86,31],[89,25],[92,22],[95,17],[97,16]];

/** Supplier-spin auto candidate. Deliberately simple and labelled approximate in the UI. */
export const pol4100Profile: ProfilePoint[] = [[0,4],[4.871,4],[7.307,13],[41,13]];
