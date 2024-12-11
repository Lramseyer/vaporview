// This section defines all of the different ways we can display the various values
// in the waveform viewer. The interface is defined by the ValueFormat interface:

export interface ValueFormat {
  // Unique identifier for the format
  id: string;

  // If true, the value will be right justified when displayed in a waveform
  rightJustify: boolean;

  // The text to display in the search symbol
  symbolText: string;

  // Function to format the string for display. The input format is an ASCII string of binary values
  // and the output format is a string that will be displayed in the viewer.
  formatString: (value: string, width: number, is2State: boolean) => string;

  // Function to calculate the  maximum width of the text in the viewer
  getTextWidth: (width: number) => number;

  // Function to check if the string is valid in the search bar
  checkValid: (value: string) => boolean;

  // Function to parse the value back to a binary string for searching
  parseValueForSearch: (value: string) => string;
}

// #region Format Hexadecimal
export const formatHex: ValueFormat = {
  id: "hexadecimal",
  rightJustify: true,
  symbolText: "hex",

  formatString: (inputString: string, width: number, is2State: boolean) => {
  // If number format is hexadecimal
    if (!is2State) {
      const stringArray = inputString.replace(/\B(?=(.{4})+(?!.))/g, "_").split("_");
      return stringArray.map((chunk) => {
        if (chunk.match(/[zZ]/)) {return "Z";}
        if (chunk.match(/[xX]/)) {return "X";}
        return parseInt(chunk, 2).toString(16);
      }).join('').replace(/\B(?=(.{4})+(?!.))/g, "_");
    } else {
      const stringArray = inputString.replace(/\B(?=(\d{16})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        const digits = Math.ceil(chunk.length / 4);
        return parseInt(chunk, 2).toString(16).padStart(digits, '0');
      }).join('_');
    }
  },

  getTextWidth: (width: number) => {
    const characterWidth = 7.69;
    const numeralCount    = Math.ceil(width / 4);
    const underscoreCount = Math.floor((width - 1) / 16);
    return (numeralCount + underscoreCount) * characterWidth;
  },

  checkValid: (inputText: string) => {
    if (inputText.match(/^(0x)?[0-9a-fA-FxzXZ_]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch: (inputText: string) =>{
    let result = inputText.replace(/_/g, '').replace(/^0x/i, '');
    result = result.split('').map((c) => {
      if (c.match(/[xXzZ]/)) {return '....';}
      return parseInt(c, 16).toString(2).padStart(4, '0');
    }).join('');
    return result;
  },
};

// #region Format Binary
export const formatBinary: ValueFormat = {
  id: "binary",
  rightJustify: true,
  symbolText: "bin",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    return inputString.replace(/\B(?=(\d{4})+(?!\d))/g, "_");
  },

  getTextWidth: (width: number) => {
    const characterWidth = 7.69;
    const numeralCount    = width;
    const underscoreCount = Math.floor((width - 1) / 4);
    return (numeralCount + underscoreCount) * characterWidth;
  },

  checkValid: (inputText: string) => {
    if (inputText.match(/^b?[01xzXZdD_]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch:(inputText: string) => {
    return inputText.replace(/_/g, '').replace(/[dD]/g, '.');
  },
};

// #region Format Decimal
const formatDecimal: ValueFormat = {
  id: "decimal",
  rightJustify: false,
  symbolText: "dec",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    let xzMask = "";
    let numericalData = inputString;

    if (!is2State) {
      numericalData = inputString.replace(/[XZ]/i, "0");
      xzMask = '|' +  inputString.replace(/[01]/g, "0");
    }
    const stringArray = numericalData.replace(/\B(?=(\d{32})+(?!\d))/g, "_").split("_");
    return stringArray.map((chunk) => {return parseInt(chunk, 2).toString(10);}).join('_') + xzMask;
  },

  getTextWidth: (width: number) => {
    const characterWidth = 7.69;
    const numeralCount    = Math.ceil(Math.log10(width % 32)) + (10 * Math.floor((width) / 32));
    const underscoreCount = Math.floor((width - 1) / 32);
    return (numeralCount + underscoreCount) * characterWidth;
  },

  checkValid: (inputText: string) => {
    if (inputText.match(/^[0-9xzXZ_,]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch: (inputText: string) => {
    const result = inputText.replace(/,/g, '');
    return result.split('_').map((n) => {
      if (n === '') {return '';}
      if (n.match(/[xXzZ]/)) {return '.{32}';}
      return parseInt(n, 10).toString(2).padStart(32, '0');
    }).join('');
  },
};

export const valueFormatList: ValueFormat[] = [formatBinary, formatHex, formatDecimal];