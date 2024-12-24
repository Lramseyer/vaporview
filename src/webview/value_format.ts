// This section defines all of the different ways we can display the various values
// in the waveform viewer. To create your own format, you need to implement a new
// ValueFormat object and add it to the valueFormatList array at the bottom of the file.
// There are helper functions supplied to discern 9-state values and to format as binary
// in case non-2-state values are invalid.
// You will also need to define a new command in the package.json file (which has examples)
// under contributes.commands and create the context menus entries under 
// contributes.menus.vaporview.valueFormat. You will also need to register the new
// command in the extension.ts (which has examples)

export function  valueIs9State(value: string): boolean {
  if (value.match(/[uxzwlh-]/)) {return true;}
  return false;
}

function formatBinaryString(inputString: string) {
  return inputString.replace(/\B(?=(\w{4})+(?!\w))/g, "_");
}

function signedBinaryStringToInt(inputString: string) {
  const isNegative = inputString[0] === '1';
  let result = parseInt(inputString, 2);
  if (isNegative) {
    result -= Math.pow(2, inputString.length);
  }
  return result.toString();
}

// The interface is defined by the ValueFormat interface:
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

  // Function to check if the string is valid in the search bar
  checkValid: (value: string) => boolean;

  // Function to parse the value back to a binary string for searching
  parseValueForSearch: (value: string) => string;

  // Function to check if the value is a 9-state value
  is9State: (value: string) => boolean;
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

        if (chunk.match(/[z]/)) {return "z";}
        if (chunk.match(/[x]/)) {return "x";}
        if (chunk.match(/[u]/)) {return "u";}
        if (chunk.match(/[w]/)) {return "w";}
        if (chunk.match(/[l]/)) {return "l";}
        if (chunk.match(/[h]/)) {return "h";}
        if (chunk.match(/[-]/)) {return "-";}
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

  is9State: valueIs9State,
};

// #region Format Octal
export const formatOctal: ValueFormat = {
  id: "octal",
  rightJustify: true,
  symbolText: "oct",

  formatString: (inputString: string, width: number, is2State: boolean) => {
  // If number format is hexadecimal
    if (!is2State) {
      const stringArray = inputString.replace(/\B(?=(.{3})+(?!.))/g, "_").split("_");
      return stringArray.map((chunk) => {

        if (chunk.match(/[z]/)) {return "z";}
        if (chunk.match(/[x]/)) {return "x";}
        if (chunk.match(/[u]/)) {return "u";}
        if (chunk.match(/[w]/)) {return "w";}
        if (chunk.match(/[l]/)) {return "l";}
        if (chunk.match(/[h]/)) {return "h";}
        if (chunk.match(/[-]/)) {return "-";}
        return parseInt(chunk, 2).toString(16);
      }).join('');
    } else {
      const stringArray = inputString.replace(/\B(?=(\d{3})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        const digits = Math.ceil(chunk.length / 3);
        return parseInt(chunk, 2).toString(8).padStart(digits, '0');
      }).join('');
    }
  },

  checkValid: (inputText: string) => {
    if (inputText.match(/^[0-7xzXZ_]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch: (inputText: string) =>{
    let result = inputText.replace(/_/g, '');
    result = result.split('').map((c) => {
      if (c.match(/[xXzZ]/)) {return '....';}
      return parseInt(c, 8).toString(2).padStart(3, '0');
    }).join('');
    return result;
  },

  is9State: valueIs9State,
};

// #region Format Binary
export const formatBinary: ValueFormat = {
  id: "binary",
  rightJustify: true,
  symbolText: "bin",

  formatString: formatBinaryString,

  checkValid: (inputText: string) => {
    if (inputText.match(/^b?[01xzXZdD_]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch:(inputText: string) => {
    return inputText.replace(/_/g, '').replace(/[dD]/g, '.');
  },

  is9State: valueIs9State,
};

// #region Format Decimal
const formatDecimal: ValueFormat = {
  id: "decimal",
  rightJustify: false,
  symbolText: "dec",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(inputString);
    }
    const numericalData = inputString;
    const stringArray = numericalData.replace(/\B(?=(\d{32})+(?!\d))/g, "_").split("_");
    return stringArray.map((chunk) => {return parseInt(chunk, 2).toString(10);}).join('_');
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

  is9State: valueIs9State,
};

// #region Format Signed
const formatSignedInt: ValueFormat = {
  id: "signed",
  rightJustify: false,
  symbolText: "int",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    if (!is2State) {
      return formatBinaryString(inputString);
    }
    return signedBinaryStringToInt(inputString).toString();
  },

  checkValid: (inputText: string) => {
    if (inputText.match(/^-?[0-9xzXZ_,]+$/)) {return true;}
    else {return false;}
  },

  parseValueForSearch: (inputText: string) => {
    const result = inputText.replace(/[,_]/g, '');
    if (inputText[0] === "-") {
      // convert number to 2's complement with the minimum number of bits
      const positive = parseInt(result, 10);
      const positiveBinary = positive.toString(2);
      const length = positiveBinary.length;
      const negativeBinary = (positive + Math.pow(2, length)).toString(2);
      if (negativeBinary.length > length) {return negativeBinary.slice(1);}
      return negativeBinary;
    } else {
      return parseInt(result, 10).toString(2);
    }
  },

  is9State: valueIs9State,
};

// #region Format String
export const formatString: ValueFormat = {
  id: "string",
  rightJustify: false,
  symbolText: "str",

  formatString: (inputString: string, width: number, is2State: boolean) => {
    return inputString;
  },

  checkValid: (inputText: string) => {
    return true;
  },

  parseValueForSearch: (inputText: string) => {
    return inputText;
  },

  is9State: () => {return false;},
};

export const valueFormatList: ValueFormat[] = [formatBinary, formatHex, formatDecimal, formatOctal, formatSignedInt, formatString];