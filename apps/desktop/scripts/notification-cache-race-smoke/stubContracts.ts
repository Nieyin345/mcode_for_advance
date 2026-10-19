export const DEFAULT_NOTIFICATION_PREFS={inAppToasts:true,mutedProjectIds:[]};
export const normalizeNotificationPrefs=(input:any)=>({...DEFAULT_NOTIFICATION_PREFS,...input});
export const isInQuietHours=()=>false;
