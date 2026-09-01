import centradoProfiles from './centradoProfiles.json';
import mainlineCatalogueProfiles from './mainlineCatalogueProfiles.json';

/** Mirrors public/assets/mouldings/POL-4875/profile.json so the renderer remains synchronous. */
export type ProfilePoint = readonly [uMm:number, zMm:number];
export const veronaProfile: ProfilePoint[] = [[0,15],[2,15],[3.5,21],[5,26],[7,27],[9,22],[12,19],[16,19],[20,25],[24,32],[29,38],[34,43],[40,46],[46,48],[51,48],[56,45],[61,40],[66,34],[71,29],[75,28],[79,32],[83,35],[86,31],[89,25],[92,22],[95,17],[97,16]];

/** Supplier-spin auto candidate. Deliberately simple and labelled approximate in the UI. */
export const pol4100Profile: ProfilePoint[] = [[0,4],[4.871,4],[7.307,13],[41,13]];

/** Supplier-spin candidates. Rebate and envelope are exact; the short inner transition is approximate. */
/** Photo-calibrated composite: a shaped silver inner section joined to a flat black outer section. */
export const pol4508SilverProfile: ProfilePoint[] = [[0,17],[.5,16],[1.2,14],[2.2,12.5],[3.3,12],[4.3,12.5],[5.3,14],[6.4,17],[7.4,21],[8.3,25.5],[9,28.5],[9.5,30]];
export const pol4508BlackProfile: ProfilePoint[] = [[0,30],[30,30]];
export const flat54x20Profile: ProfilePoint[] = [[0,6],[4.5,6],[6.5,20],[54,20]];
export const centradoProfile = (sku:string):ProfilePoint[]|undefined =>
  (centradoProfiles as Record<string,unknown>)[sku] as ProfilePoint[]|undefined;
/** Metric candidates extracted from isolated cross-sections in ml_catalogue.pdf. */
export const mainlineCatalogueProfile = (sku:string):ProfilePoint[]|undefined =>
  (mainlineCatalogueProfiles as Record<string,unknown>)[sku] as ProfilePoint[]|undefined;

/** SAM 2.1 base-plus candidates. Experimental and intentionally switchable in the UI. */
export const pol4508SamSilverProfile: ProfilePoint[] = [[0,13],[.625,13.393],[1,14.45],[1.5,14.5],[2,15.433],[3.5,15.5],[4,16.324],[5.75,16.324],[6.625,16.998],[7.625,21.908],[8.25,28.929],[9.5,28.968]];
export const pol4508SamBlackProfile: ProfilePoint[] = [[9.5,28.968],[14.25,29.118],[14.75,29.464],[27.75,29.559],[28.25,30],[28.625,29.743],[29,30],[29.5,29.61],[30,28.676]];
export const veronaSamProfile: ProfilePoint[] = [[0,18.101],[.404,19.274],[.808,19.32],[1.617,20.448],[3.638,20.448],[4.446,22.138],[5.658,20.494],[8.892,20.89],[10.508,22.403],[11.317,21.693],[13.337,21.899],[14.55,20.448],[16.975,19.702],[17.379,18.393],[20.208,15.754],[23.038,15.754],[25.058,16.536],[26.271,17.669],[28.292,17.726],[30.717,19.274],[40.417,18.883],[41.629,21.621],[42.842,22.012],[46.883,22.012],[47.692,23.968],[48.5,24.163],[49.308,27.097],[50.521,27.488],[52.542,30.392],[53.35,30.617],[53.754,29.241],[54.158,29.052],[55.371,31.184],[56.179,31.029],[56.987,31.834],[58.604,34.919],[59.412,35.369],[59.817,36.484],[60.625,36.875],[61.838,38.982],[63.05,43.172],[64.667,44.567],[65.879,44.698],[66.688,47.435],[69.517,47.846],[69.921,49],[70.729,48.878],[71.133,47.827],[71.942,47.752],[72.346,48.974],[72.75,49],[75.579,47.258],[77.196,42.91],[78.004,23.001],[78.812,14.972],[83.258,13.407],[86.088,13.324],[88.512,11.843],[92.958,11.843],[94.575,11.388],[95.787,10.278],[96.596,10.278],[97,8.616]];
