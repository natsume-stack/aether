export type UserInfo = {
  /**
   * 用户头像
   */
  avatar: string;
  /**
   * 用户id
   * 如果为0，表示未登录
   */
  userId: number;
  /**
   * 是否是管理员
   */
  isAdmin: boolean;
};
