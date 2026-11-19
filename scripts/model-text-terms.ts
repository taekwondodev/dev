export const INTERNAL =
  /\b(lead|leaf|leaves|child|children|coordinat(?!e\b)\w*|attempts?|outcomes?|reservations?|(?:un)?reserve[sd]?|admission|admit\w*|grants?|attachments?|handoffs?|bindings?|bound|parked|sweep\w*|swept|gates?|authorit(?:y|ies)|controllers?|workers?|owners?|owned|producer|dispatch rules?|integration targets?|write acquisitions?|acquisitions?|residue|dev-cycle|ADR|workspaces|(?<![/`])workspace(?!`|\]| (?-i:(?:Use )?Id\b)| (?:\[?list|inspect|check|release|resume|set-target|record-publication|artifacts|commands?)\b))\b/i

export const keyWords = (key: string): string => key.replace(/([a-z])([A-Z])/g, '$1 $2')
