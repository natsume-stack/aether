import { createContext } from 'react';

export interface FileMenuContextProps {
  onClose: () => void;
}

export const FileMenuContext = createContext<FileMenuContextProps>({
  onClose: () => {},
});
