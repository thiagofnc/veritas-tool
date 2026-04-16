module i2c_master_write #(
    parameter integer CLK_DIV = 8
) (
    input  wire       clk,
    input  wire       rst,
    input  wire       start,
    input  wire [6:0] slave_addr,
    input  wire [7:0] payload,
    input  wire       sda_in,
    output reg        scl_drive_low,
    output reg        sda_drive_low,
    output reg        busy,
    output reg        done,
    output reg        ack_error
);
    localparam [4:0] STATE_IDLE        = 5'd0;
    localparam [4:0] STATE_START_A     = 5'd1;
    localparam [4:0] STATE_START_B     = 5'd2;
    localparam [4:0] STATE_ADDR_SETUP  = 5'd3;
    localparam [4:0] STATE_ADDR_HIGH   = 5'd4;
    localparam [4:0] STATE_ADDR_LOW    = 5'd5;
    localparam [4:0] STATE_ACK1_SETUP  = 5'd6;
    localparam [4:0] STATE_ACK1_HIGH   = 5'd7;
    localparam [4:0] STATE_ACK1_LOW    = 5'd8;
    localparam [4:0] STATE_DATA_SETUP  = 5'd9;
    localparam [4:0] STATE_DATA_HIGH   = 5'd10;
    localparam [4:0] STATE_DATA_LOW    = 5'd11;
    localparam [4:0] STATE_ACK2_SETUP  = 5'd12;
    localparam [4:0] STATE_ACK2_HIGH   = 5'd13;
    localparam [4:0] STATE_ACK2_LOW    = 5'd14;
    localparam [4:0] STATE_STOP_A      = 5'd15;
    localparam [4:0] STATE_STOP_B      = 5'd16;
    localparam [4:0] STATE_STOP_C      = 5'd17;

    reg [4:0]  state;
    reg [7:0]  shift_reg;
    reg [2:0]  bit_index;
    reg [15:0] div_count;
    reg        tick;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            div_count <= 16'd0;
            tick <= 1'b0;
        end else if (busy) begin
            if (div_count == CLK_DIV - 1) begin
                div_count <= 16'd0;
                tick <= 1'b1;
            end else begin
                div_count <= div_count + 16'd1;
                tick <= 1'b0;
            end
        end else begin
            div_count <= 16'd0;
            tick <= 1'b0;
        end
    end

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            state <= STATE_IDLE;
            shift_reg <= 8'd0;
            bit_index <= 3'd7;
            scl_drive_low <= 1'b0;
            sda_drive_low <= 1'b0;
            busy <= 1'b0;
            done <= 1'b0;
            ack_error <= 1'b0;
        end else begin
            done <= 1'b0;

            case (state)
                STATE_IDLE: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b0;
                    busy <= 1'b0;
                    ack_error <= 1'b0;
                    bit_index <= 3'd7;
                    if (start) begin
                        busy <= 1'b1;
                        shift_reg <= {slave_addr, 1'b0};
                        state <= STATE_START_A;
                    end
                end

                STATE_START_A: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b1;
                    if (tick) state <= STATE_START_B;
                end

                STATE_START_B: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b1;
                    if (tick) begin
                        bit_index <= 3'd7;
                        state <= STATE_ADDR_SETUP;
                    end
                end

                STATE_ADDR_SETUP: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) state <= STATE_ADDR_HIGH;
                end

                STATE_ADDR_HIGH: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) state <= STATE_ADDR_LOW;
                end

                STATE_ADDR_LOW: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) begin
                        if (bit_index == 3'd0) begin
                            state <= STATE_ACK1_SETUP;
                        end else begin
                            bit_index <= bit_index - 3'd1;
                            state <= STATE_ADDR_SETUP;
                        end
                    end
                end

                STATE_ACK1_SETUP: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b0; // release
                    if (tick) state <= STATE_ACK1_HIGH;
                end

                STATE_ACK1_HIGH: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b0;
                    if (tick) begin
                        if (sda_in) ack_error <= 1'b1;
                        shift_reg <= payload;
                        bit_index <= 3'd7;
                        state <= STATE_ACK1_LOW;
                    end
                end

                STATE_ACK1_LOW: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b0;
                    if (tick) state <= STATE_DATA_SETUP;
                end

                STATE_DATA_SETUP: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) state <= STATE_DATA_HIGH;
                end

                STATE_DATA_HIGH: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) state <= STATE_DATA_LOW;
                end

                STATE_DATA_LOW: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= ~shift_reg[bit_index];
                    if (tick) begin
                        if (bit_index == 3'd0) begin
                            state <= STATE_ACK2_SETUP;
                        end else begin
                            bit_index <= bit_index - 3'd1;
                            state <= STATE_DATA_SETUP;
                        end
                    end
                end

                STATE_ACK2_SETUP: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b0; // release
                    if (tick) state <= STATE_ACK2_HIGH;
                end

                STATE_ACK2_HIGH: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b0;
                    if (tick) begin
                        if (sda_in) ack_error <= 1'b1;
                        state <= STATE_ACK2_LOW;
                    end
                end

                STATE_ACK2_LOW: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b0;
                    if (tick) state <= STATE_STOP_A;
                end

                STATE_STOP_A: begin
                    scl_drive_low <= 1'b1;
                    sda_drive_low <= 1'b1; // keep low
                    if (tick) state <= STATE_STOP_B;
                end

                STATE_STOP_B: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b1;
                    if (tick) state <= STATE_STOP_C;
                end

                STATE_STOP_C: begin
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b0; // release SDA high while SCL high -> STOP
                    if (tick) begin
                        busy <= 1'b0;
                        done <= 1'b1;
                        state <= STATE_IDLE;
                    end
                end

                default: begin
                    state <= STATE_IDLE;
                    scl_drive_low <= 1'b0;
                    sda_drive_low <= 1'b0;
                    busy <= 1'b0;
                    done <= 1'b0;
                    ack_error <= 1'b0;
                    bit_index <= 3'd7;
                end
            endcase
        end
    end
endmodule
