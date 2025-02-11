import { ethers } from "ethers";

interface ContractMetadata {
  address: string;
  network: string;
  abi: any;
  sourceCode: string;
  bytecode: string;
  compilerVersion: string;
  optimizationUsed: boolean;
  constructorArguments?: string;
}

interface StorageLayout {
  slots: StorageSlot[];
  types: Record<string, StorageType>;
}

interface StorageSlot {
  name: string;
  type: string;
  slot: number;
  offset: number;
}

interface StorageType {
  encoding: string;
  label: string;
  numberOfBytes: string;
  base?: string;
  members?: StorageSlot[];
}

class ContractAnalyzer {
  private etherscanApiKey: string;
  private cache: Map<string, ContractMetadata>;

  constructor(etherscanApiKey: string) {
    this.etherscanApiKey = etherscanApiKey;
    this.cache = new Map();
  }

  async analyze(
    contractAddress: string,
    network: string = "mainnet"
  ): Promise<ContractMetadata> {
    // Check cache first
    const cacheKey = `${network}:${contractAddress}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      // Fetch all necessary data in parallel
      const [sourceCodeData, abiData, bytecodeData] = await Promise.all([
        this.getContractSourceCode(contractAddress, network),
        this.getContractABI(contractAddress, network),
        this.getContractBytecode(contractAddress, network),
      ]);

      const metadata: ContractMetadata = {
        address: contractAddress,
        network,
        abi: abiData,
        sourceCode: sourceCodeData.SourceCode,
        bytecode: bytecodeData,
        compilerVersion: sourceCodeData.CompilerVersion,
        optimizationUsed: sourceCodeData.OptimizationUsed === "1",
        constructorArguments: sourceCodeData.ConstructorArguments,
      };

      // Cache the results
      this.cache.set(cacheKey, metadata);
      return metadata;
    } catch (error) {
      console.error("Error analyzing contract:", error);
      throw error;
    }
  }

  private async getContractSourceCode(
    contractAddress: string,
    network: string
  ): Promise<any> {
    const baseURL = this.getEtherscanBaseURL(network);
    const response = await fetch(
      `${baseURL}?module=contract&action=getsourcecode&address=${contractAddress}&apikey=${this.etherscanApiKey}`
    );
    const data = await response.json();

    if (data.status !== "1" || !data.result[0]) {
      throw new Error(
        `Failed to fetch source code: ${data.message || "Unknown error"}`
      );
    }

    return data.result[0];
  }

  private async getContractABI(
    contractAddress: string,
    network: string
  ): Promise<any> {
    const baseURL = this.getEtherscanBaseURL(network);
    const response = await fetch(
      `${baseURL}?module=contract&action=getabi&address=${contractAddress}&apikey=${this.etherscanApiKey}`
    );
    const data = await response.json();

    if (data.status !== "1") {
      throw new Error(`Failed to fetch ABI: ${data.message}`);
    }

    return JSON.parse(data.result);
  }

  private async getContractBytecode(
    contractAddress: string,
    network: string
  ): Promise<string> {
    const provider = this.getProvider(network);
    const bytecode = await provider.getCode(contractAddress);

    if (bytecode === "0x") {
      throw new Error("Contract not found or has no bytecode");
    }

    return bytecode;
  }

  private getEtherscanBaseURL(network: string): string {
    return network === "mainnet"
      ? "https://api.etherscan.io/api"
      : `https://api-${network}.etherscan.io/api`;
  }

  private getProvider(network: string): ethers.Provider {
    // 실제 구현에서는 네트워크별 RPC URL 설정 필요
    const rpcUrl =
      network === "mainnet"
        ? `https://eth-mainnet.g.alchemy.com/v2/`
        : `https://eth-${network}.g.alchemy.com/v2/YOUR-API-KEY`;

    return new ethers.JsonRpcProvider(rpcUrl);
  }

  // Storage layout analysis methods
  async analyzeStorageLayout(
    metadata: ContractMetadata
  ): Promise<StorageLayout> {
    const bytecode = metadata.bytecode;
    const abi = metadata.abi;
    const slots: StorageSlot[] = [];
    const types: Record<string, StorageType> = {};

    // 1. ABI에서 상태 변수 정보 추출
    const stateVariables = this.extractStateVariablesFromABI(abi);

    // 2. 바이트코드에서 storage 접근 패턴 분석
    const storageAccesses = this.analyzeStorageAccesses(bytecode);

    // 3. 상태 변수와 storage 접근 패턴 매칭
    for (const variable of stateVariables) {
      const slot = this.determineStorageSlot(
        variable,
        storageAccesses,
        metadata
      );
      const typeInfo = this.getTypeInfo(variable.type);

      slots.push({
        name: variable.name,
        type: variable.type,
        slot: slot, // 매핑도 단순 숫자로 표시
        offset: 0,
      });

      types[variable.type] = typeInfo;
    }

    return { slots, types };
  }

  private extractStateVariablesFromABI(
    abi: any[]
  ): Array<{ name: string; type: string }> {
    const variables: Array<{ name: string; type: string }> = [];

    for (const item of abi) {
      // 1. getter 함수로 노출된 public 상태 변수 찾기
      if (
        item.type === "function" &&
        item.inputs.length === 0 &&
        (item.stateMutability === "view" || item.constant === true) &&
        item.outputs?.length === 1
      ) {
        // 특정 함수들 제외 (순수 getter 함수)
        if (
          item.name === "totalSupply" ||
          item.name === "decimals" ||
          item.name === "version" ||
          item.name === "getOwner"
        ) {
          continue;
        }

        variables.push({
          name: item.name,
          type: this.inferTypeFromOutput(item.outputs[0]),
        });
      }

      // 2. mapping getter 함수 찾기
      if (
        item.type === "function" &&
        item.inputs.length === 1 &&
        (item.stateMutability === "view" || item.constant === true) &&
        item.outputs?.length === 1
      ) {
        // balanceOf, allowance 등의 mapping getter
        if (item.name === "balanceOf") {
          variables.push({
            name: "_balances",
            type: `mapping(${item.inputs[0].type} => ${item.outputs[0].type})`,
          });
        } else if (item.name === "allowance") {
          variables.push({
            name: "_allowances",
            type: `mapping(${item.inputs[0].type} => mapping(${item.inputs[1].type} => ${item.outputs[0].type}))`,
          });
        }
      }
    }

    return variables;
  }

  private inferTypeFromOutput(output: any): string {
    if (output.type.startsWith("uint")) {
      return output.type;
    } else if (output.type === "bool") {
      return "bool";
    } else if (output.type === "address") {
      return "address";
    } else if (output.type === "string") {
      return "string";
    } else {
      return output.type;
    }
  }

  private analyzeStorageAccesses(bytecode: string): Map<number, string> {
    const storageAccesses = new Map<number, string>();
    const opcodes = this.disassembleBytecode(bytecode);

    for (let i = 0; i < opcodes.length; i++) {
      const opcode = opcodes[i];
      if (opcode === "SLOAD" || opcode === "SSTORE") {
        // 이전 opcode들을 분석하여 storage slot 번호 추출
        const slot = this.findPrecedingPush(opcodes, i);
        if (slot !== undefined) {
          storageAccesses.set(slot, opcode);
        }
      }
    }

    return storageAccesses;
  }

  private disassembleBytecode(bytecode: string): string[] {
    // 바이트코드를 opcode 배열로 변환
    const opcodes: string[] = [];
    let i = 0;

    while (i < bytecode.length) {
      const opcode = this.getOpcode(bytecode.slice(i, i + 2));
      opcodes.push(opcode);
      i += 2;

      // PUSH 연산의 경우 데이터 길이만큼 추가로 건너뛰기
      if (opcode.startsWith("PUSH")) {
        const size = parseInt(opcode.slice(4));
        i += size * 2;
      }
    }

    return opcodes;
  }

  private getOpcode(hex: string): string {
    // EVM opcode 맵핑
    const opcodes: Record<string, string> = {
      "54": "SLOAD",
      "55": "SSTORE",
      "60": "PUSH1",
      // ... 필요한 다른 opcode들 추가
    };
    return opcodes[hex] || hex;
  }

  private findPrecedingPush(
    opcodes: string[],
    currentIndex: number
  ): number | undefined {
    // SLOAD/SSTORE 이전의 PUSH 연산에서 storage slot 번호 찾기
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (opcodes[i].startsWith("PUSH")) {
        const value = parseInt(opcodes[i + 1], 16);
        return value;
      }
    }
    return undefined;
  }

  private getTypeInfo(type: string): StorageType {
    const typeMap: Record<string, StorageType> = {
      address: {
        encoding: "inplace",
        label: "address",
        numberOfBytes: "20",
      },
      uint256: {
        encoding: "inplace",
        label: "uint256",
        numberOfBytes: "32",
      },
      uint8: {
        encoding: "inplace",
        label: "uint8",
        numberOfBytes: "1",
      },
      bool: {
        encoding: "inplace",
        label: "bool",
        numberOfBytes: "1",
      },
      string: {
        encoding: "bytes",
        label: "string",
        numberOfBytes: "32",
      },
    };

    // 사용자 정의 타입 (예: Roles.Role, SeigManagerI)
    if (type.includes(".") || !typeMap[type]) {
      return {
        encoding: "inplace",
        label: type,
        numberOfBytes: "32",
      };
    }

    return typeMap[type];
  }

  private extractMappingTypes(type: string): [string, string] {
    const matches = type.match(/mapping\s*\(([^==>]*?)\s*=>\s*([^;{]*?)\)/);
    if (!matches) {
      throw new Error(`Invalid mapping type: ${type}`);
    }
    return [matches[1].trim(), matches[2].trim()];
  }

  private determineStorageSlot(
    variable: { name: string; type: string },
    storageAccesses: Map<number, string>,
    metadata: ContractMetadata
  ): number {
    // slots 배열에서의 인덱스를 슬롯 번호로 사용
    const stateVariables = this.extractStateVariablesFromABI(metadata.abi);
    const index = stateVariables.findIndex((v) => v.name === variable.name);

    // 변수를 찾지 못한 경우 NaN 반환
    return index === -1 ? NaN : index;
  }

  async verifyStorageLayout(
    contractAddress: string,
    network: string = "mainnet"
  ): Promise<void> {
    const metadata = await this.analyze(contractAddress, network);
    const layout = await this.analyzeStorageLayout(metadata);
    const provider = this.getProvider(network);

    console.log("\nVerifying Storage Layout...\n");
    let mismatchFound = false;

    // 먼저 예상되는 슬롯 범위를 벗어난 위치에 데이터가 있는지 확인
    const maxSlot = Math.max(...layout.slots.map((s) => s.slot));
    for (let i = 0; i <= maxSlot + 5; i++) {
      if (!layout.slots.find((s) => s.slot === i)) {
        const value = await provider.getStorage(contractAddress, i);
        if (
          value !==
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        ) {
          console.log(`⚠️ WARNING: Unexpected data found in slot ${i}`);
          console.log(`- Raw Value: ${value}`);
          mismatchFound = true;
        }
      }
    }

    // 분석된 각 슬롯 검증
    for (const slot of layout.slots) {
      const storageValue = await provider.getStorage(
        contractAddress,
        slot.slot
      );
      console.log(`\nSlot ${slot.slot} (${slot.name})`);
      console.log(`- Type: ${slot.type}`);
      console.log(`- Raw Value: ${storageValue}`);

      // Decode the value based on type
      const decodedValue = await this.decodeStorageValue(
        storageValue,
        slot.type
      );
      console.log(`- Decoded Value: ${decodedValue}`);

      // 타입에 따른 값 검증
      const isValidValue = this.validateStorageValue(
        storageValue,
        slot.type,
        decodedValue
      );
      if (!isValidValue) {
        console.log(
          `⚠️ WARNING: Value in slot ${slot.slot} doesn't match expected format for type ${slot.type}`
        );
        mismatchFound = true;
      }
      console.log("-------------------");
    }

    // 검증 결과 요약
    if (mismatchFound) {
      console.log("\n❌ Storage Layout Verification Result: MISMATCH DETECTED");
      console.log("Potential issues found:");
      console.log("1. Unexpected data found in unmapped slots");
      console.log("2. Values don't match their declared types");
      console.log(
        "3. The contract might be using proxy patterns or upgradeable patterns"
      );
      console.log("\nSuggested actions:");
      console.log("- Review the contract's inheritance chain");
      console.log("- Check if the contract uses proxy patterns");
      console.log("- Verify the compiler version and optimization settings");
    } else {
      console.log("\n✅ Storage Layout Verification Result: MATCH");
      console.log(
        "All analyzed slots contain data consistent with their declared types."
      );
    }
  }

  private validateStorageValue(
    value: string,
    type: string,
    decodedValue: string
  ): boolean {
    // 빈 값은 항상 유효
    if (
      value ===
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return true;
    }

    try {
      if (type.startsWith("uint")) {
        // uint 타입의 경우 숫자로 변환 가능해야 함
        BigInt(decodedValue);
        return true;
      } else if (type === "address") {
        // 주소의 경우 올바른 형식이어야 함
        return ethers.isAddress(decodedValue);
      } else if (type === "bool") {
        // bool은 정확히 0x0 또는 0x1이어야 함
        return (
          value ===
            "0x0000000000000000000000000000000000000000000000000000000000000000" ||
          value ===
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      } else if (type.startsWith("mapping")) {
        // mapping은 특별한 검증 없이 통과
        return true;
      } else if (type === "string") {
        // string은 특별한 검증 없이 통과
        return true;
      }
      return true; // 알 수 없는 타입은 일단 통과
    } catch {
      return false; // 변환 과정에서 에러가 발생하면 유효하지 않은 값
    }
  }

  private async decodeStorageValue(
    value: string,
    type: string
  ): Promise<string> {
    if (
      value ===
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return "0 or empty";
    }

    // Handle different types
    if (type.startsWith("uint")) {
      return ethers.toBigInt(value).toString();
    } else if (type === "address") {
      return ethers.getAddress("0x" + value.slice(-40));
    } else if (type === "bool") {
      return value ===
        "0x0000000000000000000000000000000000000000000000000000000000000001"
        ? "true"
        : "false";
    } else if (type.startsWith("mapping")) {
      return "mapping (individual values must be queried with keys)";
    } else if (type === "string") {
      // For strings, we need to check if it's stored inline or in separate slots
      const length = ethers.toBigInt(value);
      if (length & 1n) {
        // Short string stored inline
        const stringData = value.slice(2);
        const stringLength = Number(length - 1n) / 2;
        const bytes = Buffer.from(stringData.slice(0, stringLength * 2), "hex");
        return bytes.toString("utf8");
      } else {
        return "long string (stored in multiple slots)";
      }
    }

    return value; // Return raw value for unknown types
  }
}

// Usage example
async function main() {
  const analyzer = new ContractAnalyzer("");

  try {
    //TON
    const contractAddress = "0x2be5e8c109e2197d077d13a82daead6a9b3433c5";
    //USDT
    // const contractAddress = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    //USDC proxy
    // const contractAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    //USDC implementation
    // const contractAddress = "0x43506849d7c04f9138d1a2050bbf3a0c054402dd";
    //SHIB
    // const contractAddress = "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"
    const metadata = await analyzer.analyze(contractAddress, "mainnet");
    // console.log('Contract Metadata:', metadata);

    // Analyze storage layout
    const storageLayout = await analyzer.analyzeStorageLayout(metadata);
    console.log("Storage Layout:", storageLayout);

    // Verify storage layout
    await analyzer.verifyStorageLayout(contractAddress, "mainnet");
  } catch (error) {
    console.error("Analysis failed:", error);
  }
}

main();

export { ContractAnalyzer, ContractMetadata, StorageLayout };
