/**
 * DrawIO Plugin
 * 
 * Handles DrawIO diagram processing in content script and DOCX export
 */
import { BasePlugin } from './base-plugin';

export class DrawioPlugin extends BasePlugin {
  constructor() {
    super('drawio');
  }
}
