import website from '../assets/i18n/zh-CN/website.json';
import common from '../assets/i18n/zh-CN/common.json';
import edit from '../assets/i18n/zh-CN/edit.json';
import play from '../assets/i18n/zh-CN/play.json';
import login from '../assets/i18n/zh-CN/login.json';
import error from '../assets/i18n/zh-CN/error.json';
import music from '../assets/i18n/zh-CN/music.json';
import voxelBuilder from '../assets/i18n/zh-CN/voxel-builder.json';

declare module 'react-intl' {
    export type I18n_Error = keyof typeof error;

    export type IntlMessageId =
        keyof typeof website
        | keyof typeof common
        | keyof typeof edit
        | keyof typeof play
        | keyof typeof login
        | I18n_Error
        | keyof typeof music
        | keyof typeof voxelBuilder
    ;
}
